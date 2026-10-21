import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as M from "../src/mcp-registry.js";
import { mcpFixtureAccess, mcpFixtureExchange, mcpFixtureMaterial } from "./fixtures/mcp-registry.js";
import { mcpDcrReady, mcpDcrSuccess, mcpDcrWrite } from "./fixtures/mcp-dcr.js";

const subject = { tenantId: "dcr-test-tenant", userId: "alice" };
function owner(scope: M.McpRegistrationOwner["scope"] = "user"): M.McpRegistrationOwner {
  return { scope, tenantId: scope === "platform" ? null : subject.tenantId, userId: scope === "user" ? subject.userId : null };
}
function fixture(authentication: "none" | "client_secret_basic" = "none") {
  let now = 100000; const store = new M.MemoryMcpRegistry(() => {}, () => now), input = mcpDcrWrite(owner(), subject, 0, "install", authentication);
  return { store, input, advance: (ms: number) => { now += ms; }, now: () => now };
}
describe("per-config dynamic AS client durable Memory state", () => {
  it.each(["platform", "tenant", "user"] as const)("resolves ready %s client without rewriting intent or inheriting another user's OAuth", async scope => {
    const o = owner(scope), store = new M.MemoryMcpRegistry(() => {}), input = mcpDcrWrite(o, subject), ready = await mcpDcrReady(store, input);
    expect(ready.view.version.config.authentication.kind).toBe("oauth_dynamic");
    expect((await store.getMcpRegistration(ready.ref))?.version).toEqual(ready.view.version);
    const resolved = M.resolveMcpDynamicClient(ready.view.version, ready.operation);
    expect(resolved.configSha256).toBe(ready.view.version.configSha256); expect(resolved.config.authentication).toMatchObject({ kind: "oauth", clientId: "dynamic-fixture-client" });
    const grant = await mcpFixtureExchange(store, o, subject); expect(grant.authorization.subject).toEqual(subject);
    if (scope !== "user") {
      const other = { ...subject, userId: "bob" }, ref = { ...ready.ref, access: mcpFixtureAccess(o, other, "runtime") };
      expect(await store.getMcpRuntimeAuthorization(ref)).toBeNull(); const second = await mcpFixtureExchange(store, o, other);
      expect(second.authorization.authorizationKey).not.toBe(grant.authorization.authorizationKey); expect(second.claim.resultAad.subject).toEqual(other);
    } else expect(() => mcpFixtureAccess(o, { ...subject, userId: "bob" }, "runtime")).toThrow(M.McpRegistryIntegrityError);
  });
  it("keeps basic secret in a separate operation AAD and rejects old as_client admission", async () => {
    const f = fixture("client_secret_basic"), ready = await mcpDcrReady(f.store, f.input);
    expect(ready.operation.clientMaterial?.aad.purpose).toBe("as_dynamic_client"); expect(ready.operation.clientMaterial?.aad.materialId).toBe(ready.operation.operationId);
    const grant = await mcpFixtureExchange(f.store, f.input.owner, subject); expect(grant.claim.clientMaterial).toEqual(ready.operation.clientMaterial);
    const other = fixture("client_secret_basic"), view = await other.store.upsertMcpRegistration(other.input);
    const ref = { access: other.input.access, owner: other.input.owner, name: other.input.name };
    const claim = await other.store.prepareMcpDynamicClient({ ...ref, configVersionId: view.version.configVersionId, expectedRevision: 1, idempotencyKey: "register", operationTimeoutMs: 30000 });
    const op = { ...ref, operationId: claim.operation.operationId, claimToken: claim.claimToken! }; await other.store.markMcpDynamicClientSending(op);
    const result = mcpDcrSuccess(claim); if (result.kind !== "success") throw new Error("fixture");
    const effective = { ...view.version, config: { ...view.version.config, authentication: { ...(view.version.config.authentication as M.McpDynamicAuthentication), kind: "oauth" as const, clientId: result.clientId } } };
    await expect(other.store.finishMcpDynamicClient({ ...op, result: { ...result, clientSecret: mcpFixtureMaterial(M.mcpSecretAad(effective, "as_client", null, 0, view.version.configVersionId)) } })).rejects.toThrow(M.McpRegistryIntegrityError);
  });
  it("issues one claim across concurrent prepare and never treats a sending replay as dispatch authority", async () => {
    const f = fixture(), view = await f.store.upsertMcpRegistration(f.input), ref = { access: f.input.access, owner: f.input.owner, name: f.input.name };
    const request = { ...ref, configVersionId: view.version.configVersionId, expectedRevision: 1, idempotencyKey: "register", operationTimeoutMs: 30000 };
    const [first, second] = await Promise.all([f.store.prepareMcpDynamicClient(request), f.store.prepareMcpDynamicClient({ ...request, operationTimeoutMs: 29000 })]);
    expect(first.claimToken).toMatch(/^[a-f0-9]{64}$/); expect(second.claimToken).toBeNull(); expect(second.operation).toEqual(first.operation);
    const op = { ...ref, operationId: first.operation.operationId, claimToken: first.claimToken! };
    expect((await f.store.markMcpDynamicClientSending(op)).state).toBe("sending"); await expect(f.store.markMcpDynamicClientSending(op)).rejects.toThrow(M.McpRegistryConflictError);
    await expect(f.store.prepareMcpDynamicClient({ ...request, idempotencyKey: "different-register" })).rejects.toThrow(M.McpRegistryConflictError);
  });
  it("turns expired native sending into permanent unknown without reclaim or receipt upgrade", async () => {
    const f = fixture(), view = await f.store.upsertMcpRegistration(f.input), ref = { access: f.input.access, owner: f.input.owner, name: f.input.name };
    const prepare = { ...ref, configVersionId: view.version.configVersionId, expectedRevision: 1, idempotencyKey: "register", operationTimeoutMs: 100 };
    const claim = await f.store.prepareMcpDynamicClient(prepare), op = { ...ref, operationId: claim.operation.operationId, claimToken: claim.claimToken! };
    await f.store.markMcpDynamicClientSending(op); f.advance(101);
    const unknown = await f.store.getMcpDynamicClient({ ...ref, configVersionId: view.version.configVersionId }); expect(unknown?.state).toBe("outcome_unknown");
    expect((await f.store.prepareMcpDynamicClient(prepare)).claimToken).toBeNull();
    expect(await f.store.finishMcpDynamicClient({ ...op, result: { kind: "outcome_unknown" } })).toEqual(unknown);
    await expect(f.store.finishMcpDynamicClient({ ...op, result: mcpDcrSuccess(claim) })).rejects.toThrow(M.McpRegistryConflictError);
    await expect(f.store.getMcpAuthorizationContext({ ...ref, access: mcpFixtureAccess(f.input.owner, subject, "runtime") })).rejects.toThrow(M.McpRegistryConflictError);
  });
  it("preserves prepared zero-dispatch failure and rejects forged claims or arbitrary config status", async () => {
    const f = fixture(), view = await f.store.upsertMcpRegistration(f.input), ref = { access: f.input.access, owner: f.input.owner, name: f.input.name };
    const claim = await f.store.prepareMcpDynamicClient({ ...ref, configVersionId: view.version.configVersionId, expectedRevision: 1, idempotencyKey: "register", operationTimeoutMs: 30000 });
    const op = { ...ref, operationId: claim.operation.operationId, claimToken: claim.claimToken! };
    await expect(f.store.markMcpDynamicClientSending({ ...op, claimToken: "a".repeat(64) })).rejects.toThrow(M.McpRegistryConflictError);
    const failed = await f.store.finishMcpDynamicClient({ ...op, result: { kind: "failed_not_dispatched" } }); expect(failed.sentAtMs).toBeNull();
    expect(await f.store.finishMcpDynamicClient({ ...op, result: { kind: "failed_not_dispatched" } })).toEqual(failed);
    await expect(f.store.getMcpDynamicClient({ ...ref, configVersionId: randomUUID() })).rejects.toThrow(M.McpRegistryConflictError);
    await expect(f.store.markMcpDynamicClientSending({ ...op, access: { kind: "mcp-registry-access-v1" } })).rejects.toThrow(M.McpRegistryIntegrityError);
  });
  it("fences a late result after disable and retains the existing unknown terminal unchanged", async () => {
    const f = fixture(), view = await f.store.upsertMcpRegistration(f.input), ref = { access: f.input.access, owner: f.input.owner, name: f.input.name };
    const claim = await f.store.prepareMcpDynamicClient({ ...ref, configVersionId: view.version.configVersionId, expectedRevision: 1, idempotencyKey: "register", operationTimeoutMs: 30000 });
    const op = { ...ref, operationId: claim.operation.operationId, claimToken: claim.claimToken! }; await f.store.markMcpDynamicClientSending(op);
    await f.store.setMcpRegistrationState({ ...ref, expectedRevision: 1, state: "disabled", idempotencyKey: "disable" });
    const unknown = await f.store.getMcpDynamicClient({ ...ref, configVersionId: view.version.configVersionId }); expect(unknown?.state).toBe("outcome_unknown");
    await expect(f.store.finishMcpDynamicClient({ ...op, result: mcpDcrSuccess(claim) })).rejects.toThrow(M.McpRegistryConflictError);
    expect(await f.store.finishMcpDynamicClient({ ...op, result: { kind: "outcome_unknown" } })).toEqual(unknown);
  });
  it("keeps historical basic AAD valid after version change clears only the obsolete secret", async () => {
    const f = fixture("client_secret_basic"), ready = await mcpDcrReady(f.store, f.input), grant = await mcpFixtureExchange(f.store, f.input.owner, subject);
    const next = await f.store.upsertMcpRegistration(mcpDcrWrite(f.input.owner, subject, 1, "upgrade", "client_secret_basic"));
    expect(next.version.configVersionId).not.toBe(ready.view.version.configVersionId);
    expect((await f.store.getMcpDynamicClient({ ...ready.ref, configVersionId: ready.view.version.configVersionId }))?.clientMaterial?.envelope).toBeNull();
    expect(await f.store.lookupMcpAuthorizationState(grant.pending.stateSha256)).toBeNull();
  });
  it("registers a never-dispatched re-enabled intent at the live revision without changing immutable bytes", async () => {
    const f = fixture("client_secret_basic"), view = await f.store.upsertMcpRegistration(f.input), ref = { access: f.input.access, owner: f.input.owner, name: f.input.name };
    await f.store.setMcpRegistrationState({ ...ref, expectedRevision: 1, state: "disabled", idempotencyKey: "disable" });
    await f.store.setMcpRegistrationState({ ...ref, expectedRevision: 2, state: "enabled", idempotencyKey: "enable" });
    const claim = await f.store.prepareMcpDynamicClient({ ...ref, configVersionId: view.version.configVersionId, expectedRevision: 3, idempotencyKey: "first-register", operationTimeoutMs: 30000 });
    expect(claim.operation.registrationRevision).toBe(3); expect(claim.registration).toEqual(view.version);
    const op = { ...ref, operationId: claim.operation.operationId, claimToken: claim.claimToken! }; await f.store.markMcpDynamicClientSending(op);
    const ready = await f.store.finishMcpDynamicClient({ ...op, result: mcpDcrSuccess(claim) }); expect(ready.clientMaterial?.aad.registrationRevision).toBe(3);
    expect((await mcpFixtureExchange(f.store, f.input.owner, subject)).authorization.registrationRevision).toBe(3);
    await f.store.setMcpRegistrationState({ ...ref, expectedRevision: 3, state: "disabled", idempotencyKey: "disable-ready" });
    await f.store.setMcpRegistrationState({ ...ref, expectedRevision: 4, state: "enabled", idempotencyKey: "enable-ready" });
    const current = await f.store.getMcpDynamicClient({ ...ref, configVersionId: view.version.configVersionId }); expect(current?.operationId).toBe(ready.operationId);
    expect(current?.state).toBe("succeeded"); expect((await f.store.getMcpRegistration(ref))?.version).toEqual(view.version);
    expect((await mcpFixtureExchange(f.store, f.input.owner, subject, "later-auth")).authorization.registrationRevision).toBe(5);
  });
  it("expires future basic credentials at the injected boundary while preserving historical ready evidence", async () => {
    const f = fixture("client_secret_basic"), ready = await mcpDcrReady(f.store, f.input, f.now() + 1000), grant = await mcpFixtureExchange(f.store, f.input.owner, subject);
    expect((await f.store.getMcpRuntimeAuthorization(grant.ref))?.credential).not.toBeNull(); f.advance(1000);
    await expect(f.store.getMcpRuntimeAuthorization(grant.ref)).rejects.toThrow(M.McpRegistryConflictError);
    expect((await f.store.getMcpDynamicClient({ ...ready.ref, configVersionId: ready.view.version.configVersionId }))?.state).toBe("succeeded");
  });
});
