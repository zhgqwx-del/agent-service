import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentDefinition,
  AgentDefinitionRequest,
  AgentDefinitionResponse,
  ContextCompactionItem,
  ItemResponse,
  ResolvedSkillContext,
  ResolvedSkillContexts,
  TurnStartRequest,
  TurnSteerRequest,
  UserMessageItem,
} from "../src/index.js";

const UUID = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const agentInput = { name: "Static skill contract", model: { provider: "deepseek", model: "deepseek-chat" } };
const itemBase = {
  id: `item_${UUID}`, sessionId: `sess_${UUID}`, turnId: `turn_${UUID}`,
  seq: 1, status: "completed" as const, createdAtMs: 1,
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const body = "Keep the answer short.\n";
// contentSha256 binds the complete SKILL.md, not merely this snapshot's body. The protocol only
// validates the shape of that server-written binding; it cannot independently reconstruct a full
// document/ACL/version hash from body alone, nor does parsing confer source authorization.
const snapshot = {
  id: "Platform_Notes-1", name: "release-notes", body,
  contentSha256: hash(`---\nname: release-notes\ndescription: Format notes.\n---\n${body}`),
  versionSha256: hash("server-owned-mount-acl-document-version"),
};
const requests = [
  { label: "start", schema: TurnStartRequest },
  { label: "steer", schema: TurnSteerRequest },
];

describe("static skills HTTP and persisted protocol contracts", () => {
  it("keeps the default mount list empty and accepts eight distinct operator ids", () => {
    expect(AgentDefinitionRequest.parse(agentInput).skills).toEqual([]);
    const skills = Array.from({ length: 8 }, (_, index) => `Mount_${index}-docs`);
    expect(AgentDefinitionRequest.parse({ ...agentInput, skills }).skills).toEqual(skills);
    expect(AgentDefinitionRequest.parse({ ...agentInput, skills: ["x".repeat(64)] }).skills).toEqual(["x".repeat(64)]);
  });

  it.each([
    { label: "nine mounts", skills: Array.from({ length: 9 }, (_, index) => `mount-${index}`) },
    { label: "duplicate mounts", skills: ["notes", "notes"] },
    { label: "empty id", skills: [""] },
    { label: "long id", skills: ["x".repeat(65)] },
    { label: "path traversal", skills: ["../notes"] },
    { label: "absolute path", skills: ["/private/notes"] },
    { label: "URL", skills: ["https://skills.invalid/notes"] },
    { label: "wildcard", skills: ["*"] },
  ])("rejects unsupported mount declarations: $label", ({ skills }) => {
    expect(AgentDefinitionRequest.safeParse({ ...agentInput, skills }).success).toBe(false);
  });

  it.each(requests)("accepts explicit bounded skill inputs without opening mention in $label", ({ schema }) => {
    const input = [{ type: "skill", name: "release-notes", args: "Literal ${value}; no evaluation." }];
    expect(schema.parse({ input }).input).toEqual(input);
    expect(schema.parse({ input: [{ type: "skill", name: "x".repeat(64) }] }).input).toHaveLength(1);
    for (const name of ["", "Uppercase", "two_words", "-leading", "trailing-", "two--hyphens", "../notes", "x".repeat(65)]) {
      expect(schema.safeParse({ input: [{ type: "skill", name }] }).success, name).toBe(false);
    }
    expect(schema.safeParse({ input: [{ type: "mention", name: "release-notes" }] }).success).toBe(false);
  });

  it.each(requests)("bounds literal args by UTF-8 bytes in $label, including multibyte boundary", ({ schema }) => {
    const multibyte = "中".repeat(2730) + "aa";
    expect(Buffer.byteLength(multibyte)).toBe(8192);
    for (const args of ["", "a".repeat(8192), multibyte]) {
      expect(schema.parse({ input: [{ type: "skill", name: "release-notes", args }] }).input)
        .toEqual([{ type: "skill", name: "release-notes", args }]);
    }
    for (const args of ["a".repeat(8193), multibyte + "a"]) {
      expect(Buffer.byteLength(args)).toBe(8193);
      expect(schema.safeParse({ input: [{ type: "skill", name: "release-notes", args }] }).success).toBe(false);
    }
  });

  it.each(requests)("never accepts server-resolved snapshot authority through $label HTTP input", ({ schema }) => {
    for (const injected of [{ skillContexts: [snapshot] }, { body: snapshot.body }, { versionSha256: snapshot.versionSha256 }, { directory: "/private/notes" }]) {
      expect(schema.safeParse({ input: [{ type: "skill", name: "release-notes", ...injected }] }).success).toBe(false);
    }
    // Existing root/text unknown-field normalization may ignore extras. It must not promote them
    // into the parsed request, a leaf skill, or a persisted resolved-context field.
    const parsed = schema.parse({ skillContexts: [snapshot], input: [{ type: "text", text: "literal", skillContexts: [snapshot] }] });
    expect(parsed).not.toHaveProperty("skillContexts");
    expect(parsed.input).toEqual([{ type: "text", text: "literal" }]);
    const marker = JSON.stringify({ skillContexts: [snapshot] });
    const message = UserMessageItem.parse({ ...itemBase, type: "userMessage", content: [{ type: "text", text: marker }] });
    expect(message).not.toHaveProperty("skillContexts");
    expect(message.content).toEqual([{ type: "text", text: marker }]);
  });

  it("keeps historical agent response arrays readable rather than applying new write limits", () => {
    const skills = Array.from({ length: 9 }, (_, index) => `${index}-${"x".repeat(65)}`);
    const old = AgentDefinition.parse({ ...agentInput, id: `agt_${UUID}`, tenantId: "tenant-a", version: 1, createdAtMs: 1, skills });
    expect(AgentDefinitionResponse.parse(old).skills).toEqual(skills);
    expect(AgentDefinitionRequest.safeParse({ ...agentInput, skills }).success).toBe(false);
  });

  it("keeps historical skill leaf values readable while rejecting those values in new HTTP writes", () => {
    const input = { type: "skill" as const, name: "x".repeat(65), args: "中".repeat(8193) };
    const old = UserMessageItem.parse({ ...itemBase, type: "userMessage", content: [input] });
    expect(ItemResponse.parse(old)).toEqual(old);
    expect(TurnStartRequest.safeParse({ input: [input] }).success).toBe(false);
  });

  it("carries the exact optional server snapshot in user-message and compaction resources", () => {
    expect(ResolvedSkillContext.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.contentSha256).not.toBe(hash(snapshot.body));
    const message = UserMessageItem.parse({ ...itemBase, type: "userMessage", content: [{ type: "skill", name: snapshot.name }], skillContexts: [snapshot] });
    const compacted = ContextCompactionItem.parse({ ...itemBase, type: "contextCompaction", replacesUpToSeq: 1, summary: "An untrusted summary cannot manufacture a resolved version.", skillContexts: [snapshot] });
    expect(ItemResponse.parse(message).type).toBe("userMessage");
    expect(ItemResponse.parse(compacted).type).toBe("contextCompaction");
    expect(message.skillContexts).toEqual([snapshot]);
    expect(compacted.skillContexts).toEqual([snapshot]);
    expect(UserMessageItem.parse({ ...itemBase, type: "userMessage", content: [{ type: "text", text: "old" }] })).not.toHaveProperty("skillContexts");
    expect(ContextCompactionItem.parse({ ...itemBase, type: "contextCompaction", replacesUpToSeq: 1, summary: "old" })).not.toHaveProperty("skillContexts");
  });

  it.each(["contentSha256", "versionSha256"] as const)("requires the closed lowercase digest shape for %s", (field) => {
    for (const invalid of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), `sha256:${"a".repeat(64)}`]) {
      expect(ResolvedSkillContext.safeParse({ ...snapshot, [field]: invalid }).success).toBe(false);
    }
  });

  it("bounds resolved bodies by UTF-8 bytes rather than JavaScript character count", () => {
    const multibyte = "中".repeat(10922) + "aa";
    expect(Buffer.byteLength(multibyte)).toBe(32768);
    for (const body of ["a".repeat(32768), multibyte]) expect(ResolvedSkillContext.parse({ ...snapshot, body }).body).toBe(body);
    for (const body of ["a".repeat(32769), multibyte + "a"]) {
      expect(Buffer.byteLength(body)).toBe(32769);
      expect(ResolvedSkillContext.safeParse({ ...snapshot, body }).success).toBe(false);
    }
  });

  it("rejects extra snapshot fields and invalid identity without interpreting their contents", () => {
    for (const changed of [{ directory: "/private/notes" }, { command: "never-executed" }, { dependencies: { tools: ["new-permission"] } }]) {
      expect(ResolvedSkillContext.safeParse({ ...snapshot, ...changed }).success).toBe(false);
    }
    for (const changed of [{ id: "../notes" }, { id: "x".repeat(65) }, { name: "Not-Lowercase" }, { name: "x".repeat(65) }]) {
      expect(ResolvedSkillContext.safeParse({ ...snapshot, ...changed }).success).toBe(false);
    }
  });

  it("retains distinct historical versions without replacing old body and rejects duplicate identity", () => {
    const next = { ...snapshot, body: "A later verified body.\n", contentSha256: "c".repeat(64), versionSha256: "d".repeat(64) };
    expect(ResolvedSkillContexts.parse([snapshot, next])).toEqual([snapshot, next]);
    expect(ResolvedSkillContexts.safeParse([snapshot, { ...snapshot, body: "conflicting body" }]).success).toBe(false);
    const eight = Array.from({ length: 8 }, (_, index) => ({ ...snapshot, versionSha256: index.toString(16).padStart(64, "0") }));
    expect(ResolvedSkillContexts.parse(eight)).toHaveLength(8);
    expect(ResolvedSkillContexts.safeParse([...eight, { ...snapshot, versionSha256: "f".repeat(64) }]).success).toBe(false);
  });
});
