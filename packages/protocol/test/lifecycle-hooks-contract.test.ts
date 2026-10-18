import { describe, expect, it } from "vitest";
import { Event, EventStreamEvent, Item, ItemResponse, LifecycleHookPhase, LifecycleHookReport,
  RUNTIME_EXTENSIONS_V1, RuntimeExtensionsIdentity, RuntimeExtensionsFleetRequest,
  runtimeExtensionsActivationMatches, runtimeExtensionsIdentitiesEqual } from "../src/index.js";

const sessionId = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const turnId = "turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const base = { sessionId, turnId, emittedAtMs: 1, seq: 2, invocationId: "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b", configSha256: "a".repeat(64) };
const identity = { lifecycleHooksSha256: "a".repeat(64), subagentsSha256: "b".repeat(64) };
describe("full lifecycle and runtime-extension wire contract", () => {
  it("selects every wire branch by its real discriminator, retaining all durable seq and omitting only live seq", () => {
    expect([...EventStreamEvent.optionsMap.keys()].sort()).toEqual([...Event.optionsMap.keys()].sort());
    for (const option of EventStreamEvent.options) {
      const original = Event.optionsMap.get(option.shape.type.value);
      const sourceSeq = original && "seq" in original.shape ? original.shape.seq : undefined;
      if (!sourceSeq) throw new Error("Original event branch is missing its seq schema.");
      if (sourceSeq.isOptional()) expect(Object.hasOwn(option.shape, "seq")).toBe(false);
      else expect("seq" in option.shape ? option.shape.seq : undefined).toBe(sourceSeq);
    }
  });
  it("keeps every actual item in the HTTP response union, including parent-owned subagent activity", () => {
    expect([...ItemResponse.optionsMap.keys()].sort()).toEqual([...Item.optionsMap.keys()].sort());
  });
  it.each(LifecycleHookPhase.options)("represents %s as durable observation, not a model-step alias or grant", phase => {
    const report = { packageId: "audit", kind: "observer", phase, outcome: "observed", configSha256: "b".repeat(64) };
    expect(LifecycleHookReport.parse(report)).toEqual(report);
    const started = { ...base, type: "lifecycle-hook/started", phase };
    const completed = { ...base, type: "lifecycle-hook/completed", phase, reports: [report] };
    expect(Event.parse(started)).toEqual(started); expect(EventStreamEvent.parse(completed)).toEqual(completed);
    expect(EventStreamEvent.safeParse({ ...completed, seq: undefined }).success).toBe(false);
    expect(Event.safeParse({ ...completed, rawResult: "private" }).success).toBe(false);
  });
  it("keeps model middleware separate from the eleven lifecycle phases", () => {
    expect(LifecycleHookPhase.safeParse("ModelStep").success).toBe(false);
    const event = { ...base, type: "lifecycle-middleware/completed", stage: "model", reports: [
      { packageId: "route", kind: "middleware", stage: "model", outcome: "modified", configSha256: "b".repeat(64) },
    ] };
    expect(EventStreamEvent.parse(event)).toEqual(event);
  });
  it("requires both activation states and complete exact digests, never an old hooks=true", () => {
    expect(RUNTIME_EXTENSIONS_V1).not.toBe("hooks");
    expect(runtimeExtensionsActivationMatches(identity, { lifecycleHooks: true, subagents: true })).toBe(true);
    expect(runtimeExtensionsActivationMatches(identity, { lifecycleHooks: true, subagents: false })).toBe(false);
    expect(runtimeExtensionsActivationMatches({ ...identity, subagentsSha256: null }, { lifecycleHooks: true, subagents: false })).toBe(true);
    expect(runtimeExtensionsActivationMatches({ lifecycleHooksSha256: null, subagentsSha256: null }, { lifecycleHooks: false, subagents: false })).toBe(false);
    expect(runtimeExtensionsIdentitiesEqual(identity, { ...identity, subagentsSha256: "c".repeat(64) })).toBe(false);
  });
  it("keeps fleet control content-free and closed", () => {
    expect(RuntimeExtensionsIdentity.safeParse({ ...identity, tenantId: "forged" }).success).toBe(false);
    expect(RuntimeExtensionsFleetRequest.safeParse({ nonce: "d".repeat(64), identity, prompt: "private" }).success).toBe(false);
  });
});
