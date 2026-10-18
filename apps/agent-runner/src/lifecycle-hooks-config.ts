import { createHash } from "node:crypto";
import { parseLifecyclePackageDefinitions } from "@agent-service/core";
import type { LifecyclePackageDefinition } from "@agent-service/core";

export interface LifecycleHooksRuntimeConfig {
  readonly enabled: boolean;
  readonly packages: readonly LifecyclePackageDefinition[];
  readonly timeoutMs: number;
  readonly maxConcurrentPerUser: number;
  /** Full static policy, including budgets and ordered packages; no path, credential or URL inputs. */
  readonly configSha256: string;
}
function invalid(): never { throw new Error("Invalid lifecycle hooks operator configuration"); }
function uniqueJsonKeys(raw: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{" || raw[i] === "[") {
      stack.push(raw[i] === "{" ? new Set() : null); if (stack.length > 12) invalid();
    } else if (raw[i] === "}" || raw[i] === "]") stack.pop();
    else if (raw[i] === '"') {
      const start = i;
      for (i++; i < raw.length; i++) { if (raw[i] === "\\") i++; else if (raw[i] === '"') break; }
      let next = i + 1; while (next < raw.length && /[\x20\t\r\n]/.test(raw[next]!)) next++;
      if (raw[next] === ":") {
        const keys = stack.at(-1), key: unknown = JSON.parse(raw.slice(start, i + 1));
        if (!keys || typeof key !== "string" || keys.has(key)) invalid(); keys.add(key);
      }
    }
  }
}
/** Closed static registry only. This parser never imports user modules or opens files/network. */
export function loadLifecycleHooksConfig(env: NodeJS.ProcessEnv): LifecycleHooksRuntimeConfig {
  const prefix = "LIFECYCLE_HOOKS_", allowed = new Set([`${prefix}ENABLED`, `${prefix}CONFIG_JSON`,
    `${prefix}TIMEOUT_MS`, `${prefix}MAX_CONCURRENT_PER_USER`]);
  if (Object.keys(env).some(key => key.startsWith(prefix) && !allowed.has(key))) invalid();
  const rawEnabled = env.LIFECYCLE_HOOKS_ENABLED ?? "0";
  if (rawEnabled !== "0" && rawEnabled !== "1") invalid();
  const integer = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    const text = raw ?? String(fallback); if (!/^[1-9][0-9]*$/.test(text)) invalid();
    const value = Number(text); if (!Number.isSafeInteger(value) || value < min || value > max) invalid(); return value;
  };
  const timeoutMs = integer(env.LIFECYCLE_HOOKS_TIMEOUT_MS, 1500, 100, 5000);
  const maxConcurrentPerUser = integer(env.LIFECYCLE_HOOKS_MAX_CONCURRENT_PER_USER, 2, 1, 8);
  const raw = env.LIFECYCLE_HOOKS_CONFIG_JSON ?? "[]"; if (Buffer.byteLength(raw) > 65_536) invalid();
  let packages: readonly LifecyclePackageDefinition[];
  try { uniqueJsonKeys(raw); packages = parseLifecyclePackageDefinitions(JSON.parse(raw)); } catch { return invalid(); }
  const enabled = rawEnabled === "1"; if (enabled && !packages.length) invalid();
  const configSha256 = createHash("sha256").update("lifecycle-hooks-runner-v1\0")
    .update(JSON.stringify({ enabled, packages, timeoutMs, maxConcurrentPerUser })).digest("hex");
  return Object.freeze({ enabled, packages, timeoutMs, maxConcurrentPerUser, configSha256 });
}
