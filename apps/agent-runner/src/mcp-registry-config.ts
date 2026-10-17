import { isAbsolute } from "node:path";
import { MCP_OAUTH_CALLBACK_PATH } from "@agent-service/protocol";

export { MCP_OAUTH_CALLBACK_PATH };

export interface McpRegistryRuntimeConfig {
  readonly enabled: boolean;
  /** A reference only. The runner separately validates and reads the protected raw-key file. */
  readonly credentialKeyFile?: string;
  readonly credentialKeyId: string;
  readonly callbackUrl?: string;
  readonly timeoutMs: number;
  readonly poolTtlMs: number;
  readonly maxPoolEntries: number;
  readonly maxConcurrentPerUser: number;
  readonly allowLoopbackForTests: boolean;
}

function invalid(): never { throw new Error("Invalid managed MCP configuration"); }

/** Resource-free parsing: never reads a key, resolves DNS, or derives a callback from a request.
 * The complete managed feature requires an explicit key/callback pair, including for no-auth
 * registrations; ambient provider secrets, arbitrary headers, commands and proxy settings are
 * not accepted as credential sources. Platform operator authority belongs to the router only. */
export function loadMcpRegistryConfig(env: NodeJS.ProcessEnv): McpRegistryRuntimeConfig {
  const allowed = new Set([
    "MCP_REGISTRY_ENABLED", "MCP_REGISTRY_CREDENTIAL_KEY_FILE", "MCP_REGISTRY_CREDENTIAL_KEY_ID",
    "MCP_REGISTRY_OAUTH_CALLBACK_URL", "MCP_REGISTRY_POOL_TTL_MS", "MCP_REGISTRY_POOL_MAX_ENTRIES",
  ]);
  if (Object.keys(env).some(key => key.startsWith("MCP_REGISTRY_") && !allowed.has(key))) invalid();
  const flag = (name: string): boolean => {
    const value = env[name] ?? "0";
    if (value !== "0" && value !== "1") invalid();
    return value === "1";
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(raw)) invalid();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
    return value;
  };
  const enabled = flag("MCP_REGISTRY_ENABLED");
  const allowLoopbackForTests = flag("MCP_ALLOW_LOOPBACK_FOR_TESTS");
  if (allowLoopbackForTests && env.NODE_ENV !== "test") invalid();
  const credentialKeyFile = env.MCP_REGISTRY_CREDENTIAL_KEY_FILE;
  if (credentialKeyFile !== undefined && (!credentialKeyFile || credentialKeyFile.length > 4096
    || !isAbsolute(credentialKeyFile) || /[\u0000-\u001f\u007f]/.test(credentialKeyFile))) invalid();
  const credentialKeyId = env.MCP_REGISTRY_CREDENTIAL_KEY_ID ?? "local-mcp-v1";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(credentialKeyId)) invalid();
  let callbackUrl: string | undefined;
  const rawCallback = env.MCP_REGISTRY_OAUTH_CALLBACK_URL;
  if (rawCallback !== undefined) {
    if (!rawCallback || Buffer.byteLength(rawCallback) > 2048 || /[\u0000-\u0020\u007f]/.test(rawCallback)) invalid();
    let url: URL;
    try { url = new URL(rawCallback); } catch { return invalid(); }
    const fixtureHttp = allowLoopbackForTests && ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (!url.hostname || url.username || url.password || url.href.includes("?") || url.href.includes("#")
      || url.pathname !== MCP_OAUTH_CALLBACK_PATH
      || url.protocol !== "https:" && !(fixtureHttp && url.protocol === "http:")) invalid();
    callbackUrl = url.href;
  }
  if ((credentialKeyFile === undefined) !== (callbackUrl === undefined)
    || enabled && credentialKeyFile === undefined) invalid();
  return Object.freeze({ enabled, credentialKeyId,
    ...(credentialKeyFile === undefined ? {} : { credentialKeyFile }),
    ...(callbackUrl === undefined ? {} : { callbackUrl }),
    timeoutMs: integer("MCP_TIMEOUT_MS", 15_000, 100, 30_000),
    poolTtlMs: integer("MCP_REGISTRY_POOL_TTL_MS", 60_000, 1_000, 300_000),
    maxPoolEntries: integer("MCP_REGISTRY_POOL_MAX_ENTRIES", 128, 1, 128),
    maxConcurrentPerUser: integer("MCP_MAX_CONCURRENT_PER_USER", 2, 1, 8),
    allowLoopbackForTests });
}
