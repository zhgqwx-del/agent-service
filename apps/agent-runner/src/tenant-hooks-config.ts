import { isAbsolute } from "node:path";

export interface TenantHooksRuntimeConfig {
  readonly enabled: boolean;
  readonly masterKeyFile?: string;
  readonly masterKeyId: string;
  readonly timeoutMs: number;
  readonly maxConcurrentPerUser: number;
  readonly allowLoopbackForTests: boolean;
}
function invalid(): never { throw new Error("Invalid managed tenant hooks configuration"); }
/** Shape validation only. The protected key file is opened by bootstrap, never by this parser. */
export function loadTenantHooksConfig(env: NodeJS.ProcessEnv): TenantHooksRuntimeConfig {
  if (Object.keys(env).some(key => key.startsWith("TENANT_HOOKS_") && key !== "TENANT_HOOKS_ENABLED"
    || key.startsWith("HOOKS_MASTER_") && !["HOOKS_MASTER_KEY_FILE", "HOOKS_MASTER_KEY_ID"].includes(key))) invalid();
  const flag = (value: string | undefined): boolean => {
    if (value !== undefined && value !== "0" && value !== "1") invalid(); return value === "1";
  };
  const integer = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) invalid(); const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid(); return value;
  };
  const enabled = flag(env.TENANT_HOOKS_ENABLED);
  const masterKeyFile = env.HOOKS_MASTER_KEY_FILE;
  const masterKeyId = env.HOOKS_MASTER_KEY_ID ?? "local-tenant-hooks-v1";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(masterKeyId)) invalid();
  if (masterKeyFile !== undefined && (!isAbsolute(masterKeyFile) || masterKeyFile.length > 4096
    || /[\x00-\x1f\x7f]/.test(masterKeyFile))) invalid();
  if (enabled && (!masterKeyFile || env.NODE_ENV === "production" && env.STORE !== "mysql")) invalid();
  const allowLoopbackForTests = flag(env.HOOKS_ALLOW_LOOPBACK_FOR_TESTS);
  if (allowLoopbackForTests && (env.NODE_ENV !== "test" || env.MCP_ALLOW_LOOPBACK_FOR_TESTS !== "1")) invalid();
  return Object.freeze({ enabled, masterKeyFile, masterKeyId, allowLoopbackForTests,
    timeoutMs: integer(env.HOOKS_TIMEOUT_MS, 1500, 100, 5000),
    maxConcurrentPerUser: integer(env.HOOKS_MAX_CONCURRENT_PER_USER, 2, 1, 8) });
}
