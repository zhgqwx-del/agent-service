import { ConfiguredToolHookService, type ConfiguredToolHookServiceOptions, type ToolHookDefinition } from "@agent-service/core";
import { readTelemetryCaptureRefKey as readProtectedHookKey } from "./telemetry-capture-ref-key.js";
import type { ToolHooksRuntimeConfig } from "./hooks-config.js";

/** Reuse only the descriptor-level protected 32-byte file reader, not telemetry keys or authority.
 * Read sequentially so a failed sibling cannot leave an unawaited file read or a late key buffer.
 * The core service copies key material before these temporary owned buffers are best-effort cleared. */
export async function createConfiguredToolHooks(
  config: ToolHooksRuntimeConfig,
  runtime: Pick<ConfiguredToolHookServiceOptions, "tenantRuntime" | "authorizeSubject">,
): Promise<ConfiguredToolHookService | undefined> {
  if (!config.enabled) return undefined;
  const buffers: Buffer[] = [];
  try {
    const hooks: ToolHookDefinition[] = [];
    for (const definition of config.hooks) {
      const acl = { id: definition.id, subjects: definition.subjects };
      if (definition.kind === "webhook") {
        const key = await readProtectedHookKey(definition.signingKeyFile); buffers.push(key);
        hooks.push({ ...acl, kind: "webhook", phase: definition.phase, endpoint: definition.endpoint, signingKey: key });
      } else if (definition.kind === "deny-tools") {
        hooks.push({ ...acl, kind: "deny-tools", phase: "preToolUse", tools: definition.tools });
      } else {
        hooks.push({ ...acl, kind: "observe-tool-result", phase: "postToolUse" });
      }
    }
    return new ConfiguredToolHookService({ enabled: true, hooks, timeoutMs: config.timeoutMs,
      maxConcurrentPerUser: config.maxConcurrentPerUser, allowLoopbackForTests: config.allowLoopbackForTests,
      tenantRuntime: runtime.tenantRuntime, authorizeSubject: runtime.authorizeSubject });
  } catch { throw new Error("Invalid tool hooks runtime configuration"); }
  finally { for (const buffer of buffers) buffer.fill(0); }
}
