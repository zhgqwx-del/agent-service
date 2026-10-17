import { describe, expect, it } from "vitest";
import { parseStaticSkillsConfig } from "../src/skills-config.js";

const entry = () => ({ id: "Operator_Mount", directory: "/opt/agent-service/skills/review", subjects: [{ tenantId: "tenant-a", userId: "user-a" }] });
const message = "Invalid static skills operator configuration";

describe("static skills operator configuration", () => {
  it("defaults to no mounts without reading environment or filesystem", () => {
    expect(parseStaticSkillsConfig(undefined)).toEqual([]);
    expect(parseStaticSkillsConfig("[]")).toEqual([]);
  });
  it("accepts a bounded exact mount ACL and freezes every returned layer", () => {
    const result = parseStaticSkillsConfig(JSON.stringify([entry()]));
    expect(result).toEqual([entry()]);
    expect([result, result[0], result[0]!.subjects, result[0]!.subjects[0]].every(Object.isFrozen)).toBe(true);
  });
  it("accepts pretty JSON without requiring a canonical property order", () => {
    expect(parseStaticSkillsConfig(JSON.stringify([{ subjects: entry().subjects, directory: entry().directory, id: entry().id }], null, 2))).toEqual([entry()]);
  });
  it.each([
    "", "null", "{}", "true", '[{"id":"secret-canary"}]',
    JSON.stringify([{ ...entry(), endpoint: "https://secret-canary.invalid" }]),
    JSON.stringify([{ ...entry(), directory: "relative/SKILL.md" }]),
    JSON.stringify([{ ...entry(), directory: "/opt/../secret-canary" }]),
    JSON.stringify([{ ...entry(), directory: "/opt//secret-canary" }]),
    JSON.stringify([{ ...entry(), directory: "/opt/skills/" }]),
    JSON.stringify([{ ...entry(), directory: "/" }]),
    JSON.stringify([{ ...entry(), directory: "/opt/secret\u0000canary" }]),
    JSON.stringify([{ ...entry(), directory: "/opt\\secret-canary" }]),
    JSON.stringify([{ ...entry(), id: "*" }]),
    JSON.stringify([{ ...entry(), subjects: [] }]),
    JSON.stringify([{ ...entry(), subjects: [{ tenantId: "tenant-a", userId: "" }] }]),
    JSON.stringify([{ ...entry(), subjects: [{ tenantId: "tenant-a", userId: "user-a", role: "admin" }] }]),
    JSON.stringify([{ ...entry(), subjects: [entry().subjects[0], entry().subjects[0]] }]),
    JSON.stringify([entry(), entry()]),
    JSON.stringify(Array.from({ length: 33 }, (_, i) => ({ ...entry(), id: `mount_${i}` }))),
    JSON.stringify([{ ...entry(), subjects: Array.from({ length: 65 }, (_, i) => ({ tenantId: "tenant-a", userId: `u${i}` })) }]),
    JSON.stringify([{ ...entry(), subjects: [{ tenantId: "t".repeat(129), userId: "u" }] }]),
    JSON.stringify([{ ...entry(), directory: "/" + "x".repeat(4096) }]),
    " ".repeat(65_537),
  ])("rejects malformed or out-of-scope configuration without echoing it (%#)", raw => {
    expect(() => parseStaticSkillsConfig(raw)).toThrow(new Error(message));
  });
  it.each([
    '[{"id":"mount","id":"other","directory":"/opt/skills","subjects":[{"tenantId":"t","userId":"u"}]}]',
    '[{"id":"mount","\\u0069d":"other","directory":"/opt/skills","subjects":[{"tenantId":"t","userId":"u"}]}]',
    '[{"id":"mount","directory":"/opt/skills","subjects":[{"tenantId":"t","userId":"u","userId":"other"}]}]',
  ])("rejects duplicate JSON keys instead of overriding ACL or mount identity (%#)", raw => {
    expect(() => parseStaticSkillsConfig(raw)).toThrow(new Error(message));
  });
  it("does not return unknown authorization or credential fields", () => {
    const raw = JSON.stringify([{ ...entry(), authorization: "Bearer secret-canary" }]);
    let error: unknown; try { parseStaticSkillsConfig(raw); } catch (value) { error = value; }
    expect(error instanceof Error && error.message === message).toBe(true);
    expect(String(error).includes("secret-canary")).toBe(false);
  });
});
