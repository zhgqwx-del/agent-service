import { describe, expect, it } from "vitest";
import { AgentDefinitionRequest, Capabilities, MANAGED_SKILL_REGISTRY_V1, PROTOCOL_VERSION,
  SkillInstallRequest, SkillDeleteRequest, SkillExportQuery, SkillExportResponse,
  SkillMountSelectors, SkillOverrides, SkillVersionsQuery, StartTurnRequest } from "../src/index.js";

const versionId = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
describe("managed skill registry wire contract", () => {
  it("preserves legacy operator ids and requires an explicit registry selector", () => {
    expect(SkillMountSelectors.parse(["Operator_Mount-1", "registry:release-guide"])).toEqual(["Operator_Mount-1", "registry:release-guide"]);
    expect(SkillMountSelectors.safeParse(["registry:Upper_Name"]).success).toBe(false);
    expect(SkillMountSelectors.safeParse(["registry:" + "x".repeat(65)]).success).toBe(false);
    expect(SkillMountSelectors.safeParse(["registry:guide", "registry:guide"]).success).toBe(false);
    expect(SkillMountSelectors.safeParse(Array.from({ length: 9 }, (_, i) => `registry:guide-${i}`)).success).toBe(false);
  });
  it("accepts only bounded unique immutable version overrides on turn start", () => {
    expect(StartTurnRequest.parse({ input: [{ type: "text", text: "hello" }], skillOverrides: [{ name: "guide", versionId }] }).skillOverrides)
      .toEqual([{ name: "guide", versionId }]);
    for (const value of [[{ name: "guide", versionId: "latest" }], [{ name: "guide", versionId, body: "untrusted" }],
      [{ name: "guide", versionId }, { name: "guide", versionId }], Array.from({ length: 9 }, (_, i) => ({ name: `guide-${i}`, versionId }))]) {
      expect(SkillOverrides.safeParse(value).success).toBe(false);
    }
  });
  it("does not accept caller authority, paths, tokens or raw content through registry management fields", () => {
    const valid = { scope: "user", document: "# hello", expectedRevision: 0 };
    expect(SkillInstallRequest.parse(valid)).toEqual(valid);
    for (const extra of [{ owner: { scope: "platform" } }, { path: "/private/key" }, { storageKey: "private" }, { access: {} }]) {
      expect(SkillInstallRequest.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
    expect(SkillInstallRequest.safeParse({ ...valid, scope: "platform" }).success).toBe(false);
    expect(SkillInstallRequest.safeParse({ ...valid, expectedRevision: -1 }).success).toBe(false);
    expect(SkillDeleteRequest.safeParse({ scope: "tenant", expectedRevision: 1 }).success).toBe(true);
    expect(SkillDeleteRequest.safeParse({ scope: "tenant", expectedRevision: null }).success).toBe(false);
  });
  it("counts the document UTF-8 bytes rather than just JavaScript characters", () => {
    expect(SkillInstallRequest.safeParse({ scope: "user", document: "中".repeat(21_845), expectedRevision: 0 }).success).toBe(true);
    expect(SkillInstallRequest.safeParse({ scope: "user", document: "中".repeat(21_846), expectedRevision: 0 }).success).toBe(false);
  });
  it("binds version pagination and export continuation to UUIDs and the original snapshot", () => {
    expect(SkillVersionsQuery.parse({ scope: "user", cursor: versionId })).toEqual({ scope: "user", limit: 25, cursor: versionId });
    expect(SkillVersionsQuery.safeParse({ scope: "user", cursor: "opaque-locator" }).success).toBe(false);
    expect(SkillExportQuery.parse({ cursor: versionId, snapshotSha256: sha })).toEqual({ limit: 10, cursor: versionId, snapshotSha256: sha });
    expect(SkillExportQuery.safeParse({ cursor: versionId }).success).toBe(false);
    expect(SkillExportQuery.safeParse({ scope: "tenant" }).success).toBe(false);
    expect(SkillExportQuery.safeParse({ limit: 26 }).success).toBe(false);
    expect(SkillExportResponse.safeParse({ schema: "user-skill-registry-export-v1", scope: "user", snapshotSha256: sha,
      slots: [], versions: [], nextCursor: null, physicalErasureComplete: true }).success).toBe(false);
  });
  it("advertises registry authority separately from the compatible static skills boolean", () => {
    const old = { protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: { streaming: true,
      replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: ["archive", "unarchive", "tombstone"],
      dynamicTools: true, mcp: [], skills: true, sandbox: ["none"], byok: true } };
    expect(Capabilities.parse(old).features.skillRegistry).toEqual([]);
    expect(Capabilities.parse(old).features.skillRegistryStorage).toBeNull();
    expect(Capabilities.parse({ ...old, features: { ...old.features, skillRegistry: [MANAGED_SKILL_REGISTRY_V1] } }).features.skillRegistry)
      .toEqual([MANAGED_SKILL_REGISTRY_V1]);
    expect(Capabilities.safeParse({ ...old, features: { ...old.features, skillRegistry: ["future-v2"] } }).success).toBe(false);
  });
  it("keeps current agent request selector limits authoritative", () => {
    const agent = { name: "registry", model: { provider: "deepseek", model: "deepseek-chat" }, skills: ["registry:guide"] };
    expect(AgentDefinitionRequest.parse(agent).skills).toEqual(["registry:guide"]);
    expect(AgentDefinitionRequest.safeParse({ ...agent, skills: ["registry:guide", "registry:guide"] }).success).toBe(false);
  });
});
