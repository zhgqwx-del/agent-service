import { createHash } from "node:crypto";
import { InputPart, LifecycleHookPhase, Limits, ModelRef, Principal } from "@agent-service/protocol";
import type { LifecycleMiddlewareReport, LifecycleMiddlewareStage } from "@agent-service/protocol";
import type { LifecycleModelInput, LifecyclePackageDefinition, LifecyclePromptInput, LifecycleToolInput } from "./lifecycle-types.js";

export const LIFECYCLE_PACKAGE_IDS = Object.freeze(["audit", "prompt-policy", "tool-policy", "memory-injection"] as const);
export const LIFECYCLE_CONFIG_ERROR = "Invalid lifecycle hooks operator configuration";
export class LifecycleHookError extends Error {
  override readonly name = "LifecycleHookError";
  constructor(readonly code: "invalid" | "closed" | "cancelled" | "timed_out" | "concurrency") {
    super("Lifecycle hook operation failed.");
  }
}
function invalid(): never { throw new LifecycleHookError("invalid"); }
export function plainLifecycleObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) invalid();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable)) invalid();
  return value as Record<string, unknown>;
}
export function lifecycleKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
export function lifecycleText(value: unknown, maximum: number, empty = false, multiline = false): string {
  if (typeof value !== "string" || !empty && !value || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString("utf8") !== value
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value)) invalid();
  return value;
}
export function lifecyclePrincipal(value: unknown): Readonly<Principal> {
  const p = plainLifecycleObject(value); lifecycleKeys(p, ["tenantId", "userId"]);
  const result = Principal.strict().safeParse({ tenantId: lifecycleText(p.tenantId, 512), userId: lifecycleText(p.userId, 128) });
  if (!result.success) invalid(); return Object.freeze(result.data);
}
export function lifecycleOwnerKey(owner: Principal): string { return JSON.stringify([owner.tenantId, owner.userId]); }
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, d]) => key !== "length" && (!("value" in d) || !d.enumerable))) invalid();
  return value;
}
function id(value: unknown): string {
  const name = lifecycleText(value, 64); if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) invalid(); return name;
}
function positive(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) invalid(); return value;
}
/** Closed, finite JSON only: no accessors/toJSON/prototypes/cycles, and bounded before serialization. */
export function copyLifecycleJson<T>(value: T, maximum = 32 * 1024 * 1024): T {
  let nodes = 0, bytes = 0; const path = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) invalid();
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") { if (!Number.isFinite(v)) invalid(); return; }
    if (typeof v === "string") { bytes += Buffer.byteLength(v); if (bytes > maximum || Buffer.from(v).toString("utf8") !== v) invalid(); return; }
    if (!v || typeof v !== "object" || path.has(v)) invalid(); path.add(v);
    if (Array.isArray(v)) { for (const entry of array(v, 32_768)) visit(entry, depth + 1); }
    else {
      for (const [key, entry] of Object.entries(plainLifecycleObject(v))) {
        bytes += Buffer.byteLength(key); if (bytes > maximum) invalid();
        if (entry !== undefined) visit(entry, depth + 1);
      }
    }
    path.delete(v);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value); if (typeof encoded !== "string" || Buffer.byteLength(encoded) > maximum) invalid();
  return JSON.parse(encoded) as T;
}
export function freezeLifecycle<T>(value: T): T {
  if (value && typeof value === "object") { for (const entry of Object.values(value)) freezeLifecycle(entry); Object.freeze(value); }
  return value;
}
function modelRef(value: unknown): ModelRef {
  const result = ModelRef.strict().safeParse(plainLifecycleObject(value)); if (!result.success) invalid();
  lifecycleText(result.data.provider, 512); lifecycleText(result.data.model, 512); return result.data;
}
function limits(value: unknown): Limits {
  const result = Limits.strict().safeParse(plainLifecycleObject(value)); if (!result.success) invalid();
  if (Object.values(result.data).some(n => !Number.isFinite(n) || !Number.isSafeInteger(n) && n !== result.data.maxCostCNY)) invalid();
  return result.data;
}
export type RegisteredLifecyclePackage = LifecyclePackageDefinition & { readonly configSha256: string };
/** The registry is fixed code, not a dynamic loader or caller-supplied callback registry. */
export function normalizeLifecyclePackages(input: unknown): readonly RegisteredLifecyclePackage[] {
  try {
    const list = array(input, 8), ids = new Set<string>();
    const packages = list.map(raw => {
      const p = plainLifecycleObject(raw); const packageId = id(p.id);
      if (ids.has(packageId)) invalid(); ids.add(packageId);
      const subjects = array(p.subjects, 64).map(lifecyclePrincipal); if (!subjects.length) invalid();
      const keys = subjects.map(lifecycleOwnerKey); if (new Set(keys).size !== keys.length) invalid();
      subjects.sort((a, b) => lifecycleOwnerKey(a) < lifecycleOwnerKey(b) ? -1 : lifecycleOwnerKey(a) > lifecycleOwnerKey(b) ? 1 : 0);
      let definition: LifecyclePackageDefinition;
      if (p.package === "audit") {
        lifecycleKeys(p, ["id", "package", "subjects", "phases"]);
        const phases = array(p.phases, 11).map(value => { const phase = LifecycleHookPhase.safeParse(value); if (!phase.success) invalid(); return phase.data; });
        if (!phases.length || new Set(phases).size !== phases.length) invalid();
        definition = { id: packageId, package: "audit", subjects, phases: LifecycleHookPhase.options.filter(phase => phases.includes(phase)) };
      } else if (p.package === "prompt-policy") {
        lifecycleKeys(p, ["id", "package", "subjects"], ["maxPromptBytes", "maxModelInputBytes", "maxSystemPromptBytes", "prependText", "appendText", "modelRef", "limits"]);
        definition = { id: packageId, package: "prompt-policy", subjects,
          ...(p.maxPromptBytes === undefined ? {} : { maxPromptBytes: positive(p.maxPromptBytes, 2 * 1024 * 1024) }),
          ...(p.maxModelInputBytes === undefined ? {} : { maxModelInputBytes: positive(p.maxModelInputBytes, 32 * 1024 * 1024) }),
          ...(p.maxSystemPromptBytes === undefined ? {} : { maxSystemPromptBytes: positive(p.maxSystemPromptBytes, 1024 * 1024) }),
          ...(p.prependText === undefined ? {} : { prependText: lifecycleText(p.prependText, 4096, true, true) }),
          ...(p.appendText === undefined ? {} : { appendText: lifecycleText(p.appendText, 4096, true, true) }),
          ...(p.modelRef === undefined ? {} : { modelRef: modelRef(p.modelRef) }),
          ...(p.limits === undefined ? {} : { limits: limits(p.limits) }) };
      } else if (p.package === "tool-policy") {
        lifecycleKeys(p, ["id", "package", "subjects", "denyTools", "rewrites"]);
        const denyTools = array(p.denyTools, 64).map(id); if (new Set(denyTools).size !== denyTools.length) invalid();
        const rewrites = array(p.rewrites, 16).map(rawRewrite => {
          const rewrite = plainLifecycleObject(rawRewrite); lifecycleKeys(rewrite, ["tool", "args"]);
          return { tool: id(rewrite.tool), args: copyLifecycleJson(rewrite.args, 16_384) };
        });
        if (new Set(rewrites.map(rewrite => rewrite.tool)).size !== rewrites.length
          || rewrites.some(rewrite => denyTools.includes(rewrite.tool))) invalid();
        definition = { id: packageId, package: "tool-policy", subjects, denyTools, rewrites };
      } else if (p.package === "memory-injection") {
        lifecycleKeys(p, ["id", "package", "subjects", "prefix", "append"]);
        definition = { id: packageId, package: "memory-injection", subjects,
          prefix: lifecycleText(p.prefix, 8192, true, true), append: lifecycleText(p.append, 8192, true, true) };
      } else invalid();
      const configSha256 = createHash("sha256").update("lifecycle-package-v1\0").update(JSON.stringify(definition)).digest("hex");
      return freezeLifecycle({ ...definition, configSha256 });
    });
    if (Buffer.byteLength(JSON.stringify(packages)) > 65_536) invalid();
    return Object.freeze(packages);
  } catch { throw new Error(LIFECYCLE_CONFIG_ERROR); }
}
/** Resource-free consumer parser. Internal per-package digests are recomputed by the service. */
export function parseLifecyclePackageDefinitions(input: unknown): readonly LifecyclePackageDefinition[] {
  return Object.freeze(normalizeLifecyclePackages(input).map(({ configSha256: _digest, ...definition }) => freezeLifecycle(definition)));
}
function report(pkg: RegisteredLifecyclePackage, stage: LifecycleMiddlewareStage, outcome: LifecycleMiddlewareReport["outcome"]): LifecycleMiddlewareReport {
  return Object.freeze({ packageId: pkg.id, kind: "middleware", stage, outcome, configSha256: pkg.configSha256 });
}
export function finalPromptDenial(packages: readonly RegisteredLifecyclePackage[], input: LifecyclePromptInput): LifecycleMiddlewareReport | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(input.input));
  const denied = packages.find(pkg => pkg.package === "prompt-policy" && bytes > (pkg.maxPromptBytes ?? 2 * 1024 * 1024));
  return denied ? report(denied, "prompt", "denied") : undefined;
}
export function finalModelDenial(packages: readonly RegisteredLifecyclePackage[], input: LifecycleModelInput): LifecycleMiddlewareReport | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(input.input)), systemBytes = Buffer.byteLength(input.systemPrompt);
  const denied = packages.find(pkg => pkg.package === "prompt-policy" && (bytes > (pkg.maxModelInputBytes ?? 32 * 1024 * 1024)
    || systemBytes > (pkg.maxSystemPromptBytes ?? 1024 * 1024)));
  return denied ? report(denied, "model", "denied") : undefined;
}
export function copyLifecyclePrompt(input: LifecyclePromptInput): LifecyclePromptInput {
  const raw = plainLifecycleObject(input); lifecycleKeys(raw, ["input"]);
  const parts = array(raw.input, 128).map(value => {
    const p = plainLifecycleObject(value);
    if (p.type === "text") lifecycleKeys(p, ["type", "text"]);
    else if (p.type === "image") lifecycleKeys(p, ["type", "blobId"], ["mimeType"]);
    else if (p.type === "skill") lifecycleKeys(p, ["type", "name"], ["args"]);
    else if (p.type === "mention") lifecycleKeys(p, ["type", "name"]);
    else invalid();
    const result = InputPart.safeParse(p); if (!result.success) invalid(); return result.data;
  });
  return { input: copyLifecycleJson(parts, 2 * 1024 * 1024) };
}
export function copyLifecycleModel(input: LifecycleModelInput): LifecycleModelInput {
  const raw = plainLifecycleObject(input); lifecycleKeys(raw, ["step", "modelRef", "systemPrompt", "input", "limits"]);
  const copied = copyLifecycleJson(array(raw.input, 2048));
  for (const entry of copied) {
    const message = plainLifecycleObject(entry);
    if (message.role === "system") { lifecycleKeys(message, ["role", "text"]); lifecycleText(message.text, 32 * 1024 * 1024, true, true); }
    else if (message.role === "user") {
      lifecycleKeys(message, ["role", "content"]);
      for (const part of array(message.content, 128)) {
        const content = plainLifecycleObject(part);
        if (content.type === "text") { lifecycleKeys(content, ["type", "text"]); lifecycleText(content.text, 2 * 1024 * 1024, true, true); }
        else if (content.type === "image") {
          lifecycleKeys(content, ["type", "blobId", "url"], ["mimeType"]);
          lifecycleText(content.blobId, 256); lifecycleText(content.url, 32 * 1024 * 1024);
          if (content.mimeType !== undefined) lifecycleText(content.mimeType, 128);
        } else invalid();
      }
    } else if (message.role === "assistant") {
      lifecycleKeys(message, ["role", "text", "toolCalls"], ["reasoning", "provider", "model"]);
      lifecycleText(message.text, 32 * 1024 * 1024, true, true);
      if (message.reasoning !== undefined) lifecycleText(message.reasoning, 32 * 1024 * 1024, true, true);
      for (const key of ["provider", "model"] as const) if (message[key] !== undefined) lifecycleText(message[key], 512);
      for (const entry of array(message.toolCalls, 128)) {
        const call = plainLifecycleObject(entry); lifecycleKeys(call, ["id", "name", "args"]);
        lifecycleText(call.id, 256); lifecycleText(call.name, 512);
      }
    } else if (message.role === "toolResult") {
      lifecycleKeys(message, ["role", "toolCallId", "name", "content", "isError"], ["details"]);
      lifecycleText(message.toolCallId, 256); lifecycleText(message.name, 512); if (typeof message.isError !== "boolean") invalid();
      for (const part of array(message.content, 128)) {
        const content = plainLifecycleObject(part);
        if (content.type === "text") { lifecycleKeys(content, ["type", "text"]); lifecycleText(content.text, 32 * 1024 * 1024, true, true); }
        else if (content.type === "image") {
          lifecycleKeys(content, ["type", "url"], ["mimeType"]); lifecycleText(content.url, 32 * 1024 * 1024);
          if (content.mimeType !== undefined) lifecycleText(content.mimeType, 128);
        } else invalid();
      }
    } else invalid();
  }
  const effective = plainLifecycleObject(raw.limits);
  lifecycleKeys(effective, ["maxSteps", "maxToolCalls", "maxWallClockMs", "maxCostCNY", "maxOutputTokensPerStep"]);
  return { step: positive(raw.step, 1_000_000), modelRef: modelRef(raw.modelRef),
    systemPrompt: lifecycleText(raw.systemPrompt, 1024 * 1024, true, true), input: copied as LifecycleModelInput["input"],
    limits: limits(effective) as Required<Limits> };
}
export function copyLifecycleTool(input: LifecycleToolInput): LifecycleToolInput {
  const raw = plainLifecycleObject(input); lifecycleKeys(raw, ["args"]); return { args: copyLifecycleJson(raw.args, 65_536) };
}
export function applyPromptPackage(pkg: RegisteredLifecyclePackage, input: LifecyclePromptInput): {
  value: LifecyclePromptInput; allow: boolean; report?: LifecycleMiddlewareReport;
} {
  if (pkg.package !== "prompt-policy") return { value: input, allow: true };
  const parts = [...input.input];
  if (pkg.prependText) parts.unshift({ type: "text", text: pkg.prependText });
  if (pkg.appendText) parts.push({ type: "text", text: pkg.appendText });
  const allow = parts.length <= 128 && Buffer.byteLength(JSON.stringify(parts)) <= (pkg.maxPromptBytes ?? 2 * 1024 * 1024);
  const changed = Boolean(pkg.prependText || pkg.appendText);
  return { value: { input: parts }, allow, report: report(pkg, "prompt", allow ? changed ? "modified" : "observed" : "denied") };
}
export function applyModelPackage(pkg: RegisteredLifecyclePackage, input: LifecycleModelInput): {
  value: LifecycleModelInput; allow: boolean; report?: LifecycleMiddlewareReport;
} {
  if (pkg.package === "memory-injection") {
    const systemPrompt = [pkg.prefix, input.systemPrompt, pkg.append].filter(Boolean).join("\n");
    const allow = Buffer.byteLength(systemPrompt) <= 1024 * 1024;
    return { value: { ...input, systemPrompt }, allow, report: report(pkg, "model", allow ? pkg.prefix || pkg.append ? "modified" : "observed" : "denied") };
  }
  if (pkg.package !== "prompt-policy") return { value: input, allow: true };
  const effectiveLimits: Required<Limits> = { ...input.limits };
  for (const key of Object.keys(pkg.limits ?? {}) as (keyof Limits)[]) {
    const limit = pkg.limits![key]!; effectiveLimits[key] = Math.min(effectiveLimits[key] ?? limit, limit);
  }
  const value = { ...input, modelRef: pkg.modelRef ?? input.modelRef, limits: effectiveLimits };
  const allow = Buffer.byteLength(JSON.stringify(input.input)) <= (pkg.maxModelInputBytes ?? 32 * 1024 * 1024)
    && Buffer.byteLength(input.systemPrompt) <= (pkg.maxSystemPromptBytes ?? 1024 * 1024);
  const changed = JSON.stringify(input.modelRef) !== JSON.stringify(value.modelRef) || JSON.stringify(input.limits) !== JSON.stringify(effectiveLimits);
  return { value, allow, report: report(pkg, "model", allow ? changed ? "modified" : "observed" : "denied") };
}
export function applyToolPackage(pkg: RegisteredLifecyclePackage, tool: string, input: LifecycleToolInput): {
  value: LifecycleToolInput; allow: boolean; report?: LifecycleMiddlewareReport;
} {
  if (pkg.package !== "tool-policy") return { value: input, allow: true };
  if (pkg.denyTools.includes(tool)) return { value: input, allow: false, report: report(pkg, "tool", "denied") };
  const rewrite = pkg.rewrites.find(entry => entry.tool === tool);
  return { value: rewrite ? { args: copyLifecycleJson(rewrite.args, 16_384) } : input,
    allow: true, report: report(pkg, "tool", rewrite ? "modified" : "observed") };
}
