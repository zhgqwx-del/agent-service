import { UserId } from "@agent-service/protocol";
import { z } from "zod";

const Server = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  endpoint: z.string().min(1).max(2048),
  subjects: z.array(z.object({
    tenantId: z.string().min(1).max(128),
    userId: UserId,
  }).strict()).min(1).max(64),
}).strict();
const Servers = z.array(Server).max(16);

export interface McpRuntimeConfig {
  enabled: boolean;
  servers: z.infer<typeof Servers>;
  timeoutMs: number;
  maxConcurrentPerUser: number;
  allowLoopbackForTests: boolean;
}

/** Operator-only anonymous endpoints. Errors never echo config, URLs, subjects, or unknown keys. */
export function loadMcpConfig(env: NodeJS.ProcessEnv): McpRuntimeConfig {
  const invalid = () => new Error("Invalid MCP operator configuration");
  const flag = (name: string) => {
    const value = env[name] ?? "0";
    if (value !== "0" && value !== "1") throw invalid();
    return value === "1";
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const text = env[name] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(text)) throw invalid();
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid();
    return value;
  };
  const enabled = flag("MCP_ENABLED");
  const allowLoopbackForTests = flag("MCP_ALLOW_LOOPBACK_FOR_TESTS");
  if (allowLoopbackForTests && env.NODE_ENV !== "test") throw invalid();
  const raw = env.MCP_SERVERS_JSON ?? "[]";
  if (Buffer.byteLength(raw) > 65_536) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw invalid(); }
  const result = Servers.safeParse(parsed);
  if (!result.success) throw invalid();
  const servers = result.data;
  if (new Set(servers.map(({ id }) => id)).size !== servers.length) throw invalid();
  for (const server of servers) {
    let url: URL;
    try { url = new URL(server.endpoint); } catch { throw invalid(); }
    const fixture = allowLoopbackForTests && ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.href.includes("?") || url.href.includes("#")
      || (url.protocol !== "https:" && !(fixture && url.protocol === "http:"))) throw invalid();
    server.endpoint = url.href;
    const subjects = server.subjects.map(({ tenantId, userId }) => JSON.stringify([tenantId, userId]));
    if (new Set(subjects).size !== subjects.length) throw invalid();
  }
  if (enabled && servers.length === 0) throw invalid();
  return {
    enabled, servers,
    timeoutMs: integer("MCP_TIMEOUT_MS", 15_000, 100, 30_000),
    maxConcurrentPerUser: integer("MCP_MAX_CONCURRENT_PER_USER", 2, 1, 8),
    allowLoopbackForTests,
  };
}
