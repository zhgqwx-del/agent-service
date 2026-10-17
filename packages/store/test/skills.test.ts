import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createSkillPackageAdmission, assertSkillPackageAdmission, createSkillRegistryAccess,
  assertSkillRegistryAccess, validateSkillOwner, SkillRegistryIntegrityError,
  type SkillOwner, type SkillPackageMetadata } from "../src/skills.js";
import { SKILL_REGISTRY_NATIVE_LOOKUP_TRIGGERS, skillRegistryFingerprintStatement } from "../src/mysql/skills-registry.js";

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

describe("0061 native key lookup contract", () => {
  it("rotates exactly nine point guards without removing any 0060 rejection predicate", async () => {
    const oldSql = await readFile(new URL("../migrations/0060_skill_registry.sql", import.meta.url), "utf8");
    const newSql = await readFile(new URL("../migrations/0061_skill_registry_native_lookup.sql", import.meta.url), "utf8");
    const definitions = (sql: string) => new Map([...sql.matchAll(/^CREATE TRIGGER (\w+) ([^\n]+)$/gm)].map(match => [match[1]!, match[0]]));
    const oldGuards = definitions(oldSql), next = definitions(newSql);
    const permanent = [...next.keys()].filter(name => !name.endsWith("_block"));
    expect(permanent.sort()).toEqual([...SKILL_REGISTRY_NATIVE_LOOKUP_TRIGGERS].sort());
    const prefixes = [
      "o.owner_sha256=NEW.owner_sha256 AND ", "i.installation_id=v.installation_id AND ",
      "v.version_id=NEW.current_version_id AND ", "s.slot_id=NEW.slot_id AND ",
      "v.version_id=NEW.version_id AND ", "s.slot_id=i.slot_id AND ", "i.installation_id=NEW.installation_id AND ",
      "t.tenant_id=JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND t.subject_id=JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND ",
      "u.tenant_id=JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND u.subject_id=JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.userId')) AND ",
      ...["a", "f", "r"].map(alias => `${alias}.tenant_id=JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND `),
    ];
    for (const name of SKILL_REGISTRY_NATIVE_LOOKUP_TRIGGERS) {
      const actual = next.get(name)!;
      expect(actual === oldGuards.get(name)).toBe(false);
      const stripped = prefixes.reduce((sql, prefix) => sql.replaceAll(prefix, ""), actual);
      expect(stripped).toBe(oldGuards.get(name));
    }
    expect([...next.keys()].filter(name => name.endsWith("_block"))).toHaveLength(3);
    expect(newSql.includes("DROP TRIGGER IF EXISTS")).toBe(false);
    expect(newSql.includes("CREATE TABLE")).toBe(false);
    expect(newSql.lastIndexOf("DROP TRIGGER trg_skill_registry_native_lookup_")).toBeLessThan(newSql.indexOf("-- agent-service-runtime-fingerprint:skill-registry-triggers:start"));
    expect(newSql.includes("COUNT(*)=763")).toBe(true);
    expect(newSql.includes("SUM(trigger_name LIKE 'trg_skill_registry_%')=20")).toBe(true);
  });
  it("rejects an uncalibrated or duplicate 0061 post-root rather than accepting the old full root", async () => {
    const source = await readFile(new URL("../migrations/0061_skill_registry_native_lookup.sql", import.meta.url), "utf8");
    const start = source.indexOf("-- agent-service-runtime-fingerprint:skill-registry-triggers:start");
    expect(start).toBeGreaterThan(0);
    const zero = source.slice(0, start) + source.slice(start).replace(/'[0-9a-f]{64}'/, `'${"0".repeat(64)}'`);
    expect(() => skillRegistryFingerprintStatement(zero, "triggers")).toThrow(SkillRegistryIntegrityError);
    expect(() => skillRegistryFingerprintStatement(source + "\n-- agent-service-runtime-fingerprint:skill-registry-triggers:end", "triggers")).toThrow(SkillRegistryIntegrityError);
  });
});
