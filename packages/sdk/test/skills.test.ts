import { describe, expect, it } from "vitest";
import { AgentServiceHttpError, createAgentServiceSkillRegistryOperatorClient, deleteInstalledSkill, exportUserSkills,
  getInstalledSkill, installSkill, listInstalledSkills, listSkillVersions, readSkillVersion } from "../src/client.js";

const version = "11111111-1111-4111-8111-111111111111", sha = "a".repeat(64);
describe("managed skill SDK", () => {
  it("keeps user/tenant management credentials in headers and exact CAS/idempotency in mutation bodies", async () => {
    const requests: Request[] = [];
    const options = { baseUrl: "https://agent.example.test/api/", serviceApiKey: "private-runtime-key", userId: "alice",
      fetch: (async (input, init) => { requests.push(new Request(input, init)); return Response.json({}); }) as typeof fetch };
    await installSkill(options, { scope: "user", document: "# document", expectedRevision: 0 }, "install-one");
    await deleteInstalledSkill(options, "release-guide", { scope: "user", expectedRevision: 1 }, "delete-one");
    expect(requests.map(r => r.method)).toEqual(["POST", "DELETE"]);
    expect(await requests[0]!.json()).toEqual({ scope: "user", document: "# document", expectedRevision: 0 });
    expect(await requests[1]!.json()).toEqual({ scope: "user", expectedRevision: 1 });
    expect(requests.map(r => r.headers.get("idempotency-key"))).toEqual(["install-one", "delete-one"]);
    for (const request of requests) { expect(request.headers.get("authorization")).toBe("Bearer private-runtime-key");
      expect(request.headers.get("x-user-id")).toBe("alice"); expect(request.url).not.toContain("private-runtime-key"); }
  });
  it("projects scope, immutable version and snapshot-bound export pagination without tenant switching fields", async () => {
    const requests: Request[] = [];
    const options = { baseUrl: "https://agent.example.test", fetch: (async (input, init) => {
      requests.push(new Request(input, init)); return Response.json({}); }) as typeof fetch };
    await listInstalledSkills(options, { scope: "user", limit: 2, cursor: sha });
    await getInstalledSkill(options, "release-guide", "tenant");
    await listSkillVersions(options, "release-guide", { scope: "user", cursor: version });
    await readSkillVersion(options, "release-guide", version, "user");
    await exportUserSkills(options, { limit: 1, cursor: version, snapshotSha256: sha });
    expect(requests.map(r => new URL(r.url).pathname)).toEqual(["/v1/skills", "/v1/skills/release-guide", "/v1/skills/release-guide/versions",
      `/v1/skills/release-guide/versions/${version}`, "/v1/skills/export"]);
    expect(new URL(requests[4]!.url).searchParams.get("scope")).toBeNull();
    expect(Object.fromEntries(new URL(requests[4]!.url).searchParams)).toEqual({ limit: "1", cursor: version, snapshotSha256: sha });
    expect(requests.every(r => r.method === "GET")).toBe(true);
  });
  it("isolates platform skill registry authority on its own path-typed client", async () => {
    const token = "private-skill-registry-operator-token-001"; let request: Request | undefined;
    const client = createAgentServiceSkillRegistryOperatorClient({ baseUrl: "https://agent.example.test", skillRegistryOperatorToken: token,
      fetch: async input => { request = input; return Response.json({ data: [], nextCursor: null }); } });
    await client.GET("/v1/platform/skills");
    expect(request!.url).toBe("https://agent.example.test/v1/platform/skills");
    expect(request!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(request!.headers.get("x-user-id")).toBeNull();
    expect(() => createAgentServiceSkillRegistryOperatorClient({ baseUrl: "https://agent.example.test", skillRegistryOperatorToken: "short" })).toThrow();
  });
  it("surfaces a server snapshot conflict without implicitly retrying or combining pages", async () => {
    let calls = 0;
    await expect(exportUserSkills({ baseUrl: "https://agent.example.test", fetch: async () => {
      calls++; return Response.json({ error: { code: "state_conflict", message: "Skill revision or idempotency conflict." } }, { status: 409 });
    } }, { cursor: version, snapshotSha256: sha })).rejects.toBeInstanceOf(AgentServiceHttpError);
    expect(calls).toBe(1);
  });
});
