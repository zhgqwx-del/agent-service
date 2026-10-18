import { isAbsolute } from "node:path";
import { Principal } from "@agent-service/protocol";
import { z } from "zod";

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const acl = { id: ID, subjects: z.array(Principal.strict()).min(1).max(64) };
const Definitions = z.array(z.discriminatedUnion("kind", [
  z.object({ ...acl, phase: z.literal("preToolUse"), kind: z.literal("deny-tools"),
    tools: z.array(ID).min(1).max(64) }).strict(),
  z.object({ ...acl, phase: z.literal("postToolUse"), kind: z.literal("observe-tool-result") }).strict(),
  z.object({ ...acl, phase: z.enum(["preToolUse", "postToolUse"]), kind: z.literal("webhook"),
    endpoint: z.string().min(1).max(2048), signingKeyFile: z.string().min(1).max(4096) }).strict(),
])).max(8);
export type OperatorToolHookDefinition = z.infer<typeof Definitions>[number];
export interface ToolHooksRuntimeConfig {
  enabled: boolean;
  hooks: readonly OperatorToolHookDefinition[];
  timeoutMs: number;
  maxConcurrentPerUser: number;
  allowLoopbackForTests: boolean;
}
function invalid(): never { throw new Error("Invalid tool hooks operator configuration"); }

/** Reject duplicate JSON keys (including escaped spellings), rather than silently replacing
 * a fixed endpoint, key reference, phase or ACL. JSON.parse is still the syntax authority. */
function uniqueKeys(raw: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "{" || c === "[") { stack.push(c === "{" ? new Set() : null); if (stack.length > 12) invalid(); }
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      const start = i;
      for (i++; i < raw.length; i++) { if (raw[i] === "\\") i++; else if (raw[i] === '"') break; }
      let next = i + 1; while (/\s/.test(raw[next] ?? "") && next < raw.length) next++;
      if (raw[next] === ":") {
        const keys = stack.at(-1); if (!keys) invalid();
        const key: unknown = JSON.parse(raw.slice(start, i + 1));
        if (typeof key !== "string" || keys.has(key)) invalid(); keys.add(key);
      }
    }
  }
}

/** Resource-free startup parsing only. Signing keys never enter env/JSON: only a protected
 * raw-key file reference is accepted. No filesystem, DNS, network or dynamic module loading. */
export function loadToolHooksConfig(env: NodeJS.ProcessEnv): ToolHooksRuntimeConfig {
  const allowed = new Set(["HOOKS_ENABLED", "HOOKS_CONFIG_JSON", "HOOKS_TIMEOUT_MS",
    "HOOKS_MAX_CONCURRENT_PER_USER", "HOOKS_ALLOW_LOOPBACK_FOR_TESTS",
    // Separate v2 parser owns these references; legacy v1 never opens or consumes them.
    "HOOKS_MASTER_KEY_FILE", "HOOKS_MASTER_KEY_ID"]);
  if (Object.keys(env).some(key => key.startsWith("HOOKS_") && !allowed.has(key))) invalid();
  const flag = (name: string): boolean => {
    const value = env[name] ?? "0"; if (value !== "0" && value !== "1") invalid(); return value === "1";
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name] ?? String(fallback); if (!/^[1-9][0-9]*$/.test(raw)) invalid();
    const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) invalid(); return value;
  };
  const enabled = flag("HOOKS_ENABLED"), allowLoopbackForTests = flag("HOOKS_ALLOW_LOOPBACK_FOR_TESTS");
  if (allowLoopbackForTests && (env.NODE_ENV !== "test" || env.MCP_ALLOW_LOOPBACK_FOR_TESTS !== "1")) invalid();
  const raw = env.HOOKS_CONFIG_JSON ?? "[]";
  if (Buffer.byteLength(raw) > 65_536) invalid();
  let value: unknown;
  try { value = JSON.parse(raw); uniqueKeys(raw); } catch { return invalid(); }
  const result = Definitions.safeParse(value); if (!result.success) invalid();
  const hooks = result.data;
  if (new Set(hooks.map(hook => hook.id)).size !== hooks.length || enabled && hooks.length === 0) invalid();
  for (const hook of hooks) {
    if (new Set(hook.subjects.map(owner => JSON.stringify([owner.tenantId, owner.userId]))).size !== hook.subjects.length) invalid();
    if (hook.kind === "deny-tools" && new Set(hook.tools).size !== hook.tools.length) invalid();
    if (hook.kind === "webhook") {
      let url: URL; try { url = new URL(hook.endpoint); } catch { return invalid(); }
      const fixture = allowLoopbackForTests && ["127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.username || url.password || url.href.includes("?") || url.href.includes("#")
        || url.protocol !== "https:" && !(fixture && url.protocol === "http:")) invalid();
      hook.endpoint = url.href;
      if (!isAbsolute(hook.signingKeyFile) || /[\u0000-\u001f\u007f]/.test(hook.signingKeyFile)) invalid();
    }
    for (const subject of hook.subjects) Object.freeze(subject);
    Object.freeze(hook.subjects); if (hook.kind === "deny-tools") Object.freeze(hook.tools); Object.freeze(hook);
  }
  return Object.freeze({ enabled, hooks: Object.freeze(hooks), allowLoopbackForTests,
    timeoutMs: integer("HOOKS_TIMEOUT_MS", 1500, 100, 5000),
    maxConcurrentPerUser: integer("HOOKS_MAX_CONCURRENT_PER_USER", 2, 1, 8) });
}
