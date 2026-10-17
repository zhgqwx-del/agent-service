import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSkillPackageAdmission, assertSkillPackageAdmission, createSkillRegistryAccess,
  assertSkillRegistryAccess, validateSkillOwner, SkillRegistryIntegrityError,
  type SkillOwner, type SkillPackageMetadata } from "../src/skills.js";

const owner: SkillOwner = { scope: "user", tenantId: "tenant", userId: "user" };
const metadata: SkillPackageMetadata = { name: "example", description: "Example", whenToUse: null,
  disableModelInvocation: false, userInvocable: true, dependencies: { tools: [] } };
const digest = createHash("sha256").update("SKILL.md fixture").digest("hex");
describe("skill registry closed server admissions", () => {
  it("accepts only original owner-bound authority, not literals or clones", () => {
    const access = createSkillRegistryAccess({ principal: { tenantId: "tenant", userId: "user" }, owner, authority: "user_self", access: "manage" });
    expect(assertSkillRegistryAccess(access, owner, true)).toEqual({ tenantId: "tenant", userId: "user" });
    expect(() => assertSkillRegistryAccess(structuredClone(access), owner, true)).toThrow(SkillRegistryIntegrityError);
    expect(() => assertSkillRegistryAccess(access, { ...owner, userId: "other" }, true)).toThrow(SkillRegistryIntegrityError);
  });
  it("does not turn read authority into manage or self access into tenant/platform management", () => {
    const platform: SkillOwner = { scope: "platform", tenantId: null, userId: null };
    const read = createSkillRegistryAccess({ principal: { tenantId: "tenant", userId: "user" }, owner: platform, authority: "user_self", access: "read" });
    expect(() => assertSkillRegistryAccess(read, platform, true)).toThrow(SkillRegistryIntegrityError);
    expect(() => createSkillRegistryAccess({ principal: { tenantId: "tenant", userId: "user" }, owner: platform, authority: "user_self", access: "manage" })).toThrow(SkillRegistryIntegrityError);
    expect(() => createSkillRegistryAccess({ principal: { tenantId: "tenant", userId: "user" }, owner: { scope: "tenant", tenantId: "other", userId: null }, authority: "tenant_admin", access: "manage" })).toThrow(SkillRegistryIntegrityError);
  });
  it("snapshots admitted metadata and rejects forged/cloned or wrong-owner admissions", () => {
    const mutable = structuredClone(metadata);
    const admission = createSkillPackageAdmission({ owner, metadata: mutable, sha256: digest, sizeBytes: 20, parserProfile: "skill-markdown-v1", guardProfile: "skills-guard-v1" });
    Object.assign(mutable, { description: "changed" });
    expect(assertSkillPackageAdmission(admission, owner, "example").metadata.description).toBe("Example");
    expect(() => assertSkillPackageAdmission(structuredClone(admission), owner, "example")).toThrow(SkillRegistryIntegrityError);
    expect(() => assertSkillPackageAdmission(admission, { ...owner, userId: "other" }, "example")).toThrow(SkillRegistryIntegrityError);
    expect(() => assertSkillPackageAdmission(admission, owner, "other")).toThrow(SkillRegistryIntegrityError);
  });
  it.each([
    { scope: "platform", tenantId: "tenant", userId: null },
    { scope: "tenant", tenantId: "tenant", userId: "user" },
    { scope: "user", tenantId: "tenant", userId: "*" },
    { scope: "user", tenantId: "中".repeat(129), userId: "user" },
    { scope: "user", tenantId: "tenant", userId: "user", extra: true },
  ])("rejects noncanonical owner shapes", value => {
    expect(() => validateSkillOwner(value)).toThrow(SkillRegistryIntegrityError);
  });
  it("preserves the shared Principal character grammar for Unicode tenants", () => {
    expect(() => validateSkillOwner({ scope: "user", tenantId: "中".repeat(100), userId: "user" })).not.toThrow();
  });
  it("rejects accessor input before invoking it and never echoes canaries", () => {
    let calls = 0;
    const value = { ...owner, get userId() { calls++; throw new Error("secret-canary"); } };
    expect(() => validateSkillOwner(value)).toThrow("skill registry evidence is invalid"); expect(calls).toBe(0);
  });
});
