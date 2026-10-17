import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as M from "../src/mcp-registry.js";
import { MemorySessionStore } from "../src/memory.js";
import { newErasureRequestId, SubjectDeletingError, userErasureRequestHash } from "../src/subject-lifecycle.js";
import { mcpFixtureAccess, mcpFixtureBegin, mcpFixtureConfig, mcpFixtureExchange, mcpFixtureMaterial, mcpFixtureWrite } from "./fixtures/mcp-registry.js";

const subject: M.McpCredentialSubject = { tenantId: "mcp-tenant", userId: "user" };
const owner: M.McpRegistrationOwner = { scope: "user", tenantId: subject.tenantId, userId: subject.userId };
async function historicalMaterialBoundaryImage(): Promise<M.McpRegistryImage> {
  const store = new MemorySessionStore(), authentication = mcpFixtureConfig.authentication; if (authentication.kind !== "oauth") throw new Error("fixture");
  const config: M.McpRegistrationConfig = { ...mcpFixtureConfig, authentication: { ...authentication, clientAuthentication: "client_secret_basic" } };
  await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject, 0, "v1", config)); const first = await mcpFixtureExchange(store, owner, subject, "epoch-one");
  await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject, 1, "v2", { ...config, description: "Version two" })); const second = await mcpFixtureExchange(store, owner, subject, "epoch-two");
  await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject, 2, "v3", { ...config, description: "Version three" }));
  const engine = Reflect.get(store, "mcpRegistryStore"), images = Reflect.get(engine, "images") as Map<string, M.McpRegistryImage>, image = structuredClone(images.get(M.mcpRegistrationId(owner, "example"))!);
  image.replays = image.replays.filter(r => r.kind !== "registration");
  const limit = M.MCP_REGISTRY_EPOCH_OPERATION_LIMIT;
  // Synthetic mathematical read-budget fixture, not a claim that 8192 SQL or
  // remote refreshes ran. Seed relations and envelopes come from real Memory
  // commits; each appended material uses the real purpose-bound cipher fixture.
  for (const [epochIndex, grant] of [first, second].entries()) {
    const epoch = grant.authorization.authorizationEpoch, template = image.operations.find(o => o.operationId === grant.claim.operation.operationId)!;
    const initial = image.credentials.find(c => c.operationId === template.operationId)!, start = epochIndex * limit + 1;
    image.operations = image.operations.map(o => o.operationId === template.operationId ? { ...o, predecessorTokenRevision: start - 1 } : o);
    image.credentials = image.credentials.map(c => c.credentialVersionId === initial.credentialVersionId ? { ...c, tokenRevision: start } : c);
    image.materials = image.materials.map(m => m.materialId === initial.materialId ? { ...m, envelope: null } : m);
    let predecessor = initial.credentialVersionId;
    for (let n = 1; n < limit; n++) {
      const operationId = randomUUID(), credentialVersionId = randomUUID(), aad = M.mcpSecretAad(grant.view.registration, "oauth_tokens", subject, epoch, credentialVersionId, template.registrationRevision);
      const material = M.assertMcpEncryptedMaterialAdmission(mcpFixtureMaterial(aad), aad);
      const operation: M.McpCredentialOperation = { ...template, operationId, predecessorTokenRevision: start + n - 1, predecessorCredentialVersionId: predecessor,
        kind: "refresh", authorizationId: null, resultCredentialVersionId: credentialVersionId,
        resultSha256: M.mcpRegistryDigest("mcp-operation-result-v1", { kind: "success", material, scopes: initial.scopes, expiresInMs: initial.accessTokenExpiresAtMs - initial.createdAtMs }) };
      image.operations.push(operation); image.credentials.push({ ...initial, credentialVersionId, operationId, tokenRevision: start + n, materialId: credentialVersionId });
      image.materials.push({ ...material, envelope: epochIndex === 1 && n === limit - 1 ? material.envelope : null }); predecessor = credentialVersionId;
    }
    if (epochIndex === 1) image.authorizations = image.authorizations.map(a => ({ ...a, tokenRevision: 2 * limit, credentialVersionId: predecessor }));
  }
  return image;
}
afterEach(() => vi.restoreAllMocks());
describe("MCP registry actual Memory atomic consumers", () => {
  it("audits two individually full epochs without widening hot quotas or accepting a third epoch or subject", async () => {
    const image = await historicalMaterialBoundaryImage();
    expect(image.operations.length).toBe(2 * M.MCP_REGISTRY_EPOCH_OPERATION_LIMIT);
    expect(image.materials.length).toBe(M.MCP_REGISTRY_HISTORICAL_MATERIAL_LIMIT);
    expect(() => M.assertMcpRegistryImage(image, owner, "example")).toThrow(M.McpRegistryIntegrityError);
    expect(() => M.assertMcpRegistryHistoricalEpochImage(image, owner, "example", 1)).not.toThrow();
    const one = image.operations[0]!;
    expect(() => M.assertMcpRegistryHistoricalEpochImage({ ...image, operations: [...image.operations, { ...one, operationId: randomUUID(), authorizationEpoch: 3 }] }, owner, "example", 1)).toThrow(M.McpRegistryIntegrityError);
    expect(() => M.assertMcpRegistryHistoricalEpochImage({ ...image, operations: [{ ...one, subject: { ...subject, userId: "other" } }, ...image.operations.slice(1)] }, owner, "example", 1)).toThrow(M.McpRegistryIntegrityError);
    expect(() => M.assertMcpRegistryHistoricalEpochImage({ ...image, operations: [...image.operations, { ...one, operationId: randomUUID() }] }, owner, "example", 1)).toThrow(M.McpRegistryIntegrityError);
    expect(() => M.assertMcpRegistryHistoricalEpochImage({ ...image, operations: [{ ...one, configVersionId: image.slot!.currentVersionId! }, ...image.operations.slice(1)] }, owner, "example", 1)).toThrow(M.McpRegistryIntegrityError);
    expect(() => M.assertMcpRegistryHistoricalEpochImage({ ...image, materials: [...image.materials, { ...image.materials[0]!, materialId: randomUUID() }] }, owner, "example", 1)).toThrow(M.McpRegistryIntegrityError);
  });
  it.each(["platform", "tenant", "user"] as const)("publishes immutable %s configuration without sharing credentials", async scope => {
    const store = new MemorySessionStore(), o: M.McpRegistrationOwner = { scope, tenantId: scope === "platform" ? null : subject.tenantId, userId: scope === "user" ? subject.userId : null };
    const input = mcpFixtureWrite(o, subject); const slot = await store.upsertMcpRegistration(input);
    expect(slot.slot.revision).toBe(1); expect(slot.version.configVersionId).toBe(slot.slot.currentVersionId); expect(await store.upsertMcpRegistration(input)).toEqual(slot);
    const ref = { access: mcpFixtureAccess(o, subject, "runtime"), owner: o, name: "example" };
    expect(await store.getMcpRuntimeAuthorization(ref)).toBeNull(); expect((await store.getMcpAuthorizationContext(ref))?.registration.config.protocolVersion).toBe("2025-11-25");
    const grant = await mcpFixtureExchange(store, o, subject);
    expect(grant.authorization.authorizationEpoch).toBe(1); expect(grant.authorization.tokenRevision).toBe(1);
    expect(Boolean((await store.getMcpRuntimeAuthorization(ref))?.material?.envelope)).toBe(true);
    if (scope !== "user") expect(await store.getMcpRuntimeAuthorization({ ...ref, access: mcpFixtureAccess(o, { ...subject, userId: "other" }, "runtime") })).toBeNull();
  });
  it("keeps same idempotency keys independent across users and registrations", async () => {
    const store = new MemorySessionStore(), o: M.McpRegistrationOwner = { scope: "platform", tenantId: null, userId: null };
    await store.upsertMcpRegistration(mcpFixtureWrite(o, subject));
    const a = await mcpFixtureBegin(store, o, subject), b = await mcpFixtureBegin(store, o, { ...subject, userId: "other" });
    expect(a.pending.authorizationKey).not.toBe(b.pending.authorizationKey);
    expect((await store.lookupMcpAuthorizationState(a.pending.stateSha256))?.subject).toEqual(subject);
    expect(await store.getMcpPendingAuthorization({ ...b.ref, idempotencyKey: "authorize" })).not.toBeNull();
  });
  it("keeps legal Unicode actual subjects distinct and never treats a byte-different tuple as the same grant", async () => {
    const store = new MemorySessionStore(), o: M.McpRegistrationOwner = { scope: "platform", tenantId: null, userId: null };
    await store.upsertMcpRegistration(mcpFixtureWrite(o, subject));
    const first = { tenantId: "中".repeat(100), userId: "user" }, other = { tenantId: "文".repeat(100), userId: "user" };
    const grant = await mcpFixtureExchange(store, o, first);
    expect((await store.getMcpRuntimeAuthorization(grant.ref))?.authorization?.subject).toEqual(first);
    expect(await store.getMcpRuntimeAuthorization({ ...grant.ref, access: mcpFixtureAccess(o, other, "runtime") })).toBeNull();
    const next = await mcpFixtureExchange(store, o, other);
    expect(next.authorization.authorizationKey).not.toBe(grant.authorization.authorizationKey);
  });
  it("consumes state once, rejects wrong redirect/state and atomically seals exchange", async () => {
    const store = new MemorySessionStore(); await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject));
    const g = await mcpFixtureExchange(store, owner, subject);
    expect(await store.lookupMcpAuthorizationState(g.pending.stateSha256)).toBeNull();
    await expect(store.consumeMcpAuthorization(g.consume)).rejects.toThrow(M.McpRegistryConflictError);
    expect(await store.finishMcpCredentialOperation(g.finish)).toEqual(g.authorization);
    const next = await mcpFixtureBegin(store, owner, subject, "next-auth"), auth = next.view.registration.config.authentication;
    if (auth.kind !== "oauth") throw new Error("fixture");
    await expect(store.consumeMcpAuthorization({ ...next.ref, authorizationId: next.pending.authorizationId, stateSha256: "b".repeat(64), redirectUri: auth.redirectUri, operationTimeoutMs: 1000 })).rejects.toThrow(M.McpRegistryConflictError);
    expect((await store.lookupMcpAuthorizationState(next.pending.stateSha256))?.authorizationId).toBe(next.pending.authorizationId);
  });
  it("single-flights exact refresh predecessors and keeps authorization epoch separate", async () => {
    const store = new MemorySessionStore(); await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject)); const g = await mcpFixtureExchange(store, owner, subject);
    const input: M.BeginMcpRefreshInput = { ...g.ref, expectedAuthorizationEpoch: 1, expectedTokenRevision: 1, expectedCredentialVersionId: g.authorization.credentialVersionId!, operationTimeoutMs: 30000 };
    const outcomes = await Promise.allSettled([store.beginMcpRefresh(input), store.beginMcpRefresh(input)]);
    expect(outcomes.map(o => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const claim = outcomes.find(o => o.status === "fulfilled"); if (claim?.status !== "fulfilled") throw new Error("fixture");
    const next = await store.finishMcpCredentialOperation({ ...g.ref, operationId: claim.value.operation.operationId, claimToken: claim.value.claimToken,
      result: { kind: "success", material: mcpFixtureMaterial(claim.value.resultAad), scopes: ["read"], expiresInMs: 60000 } });
    expect(next.authorizationEpoch).toBe(1); expect(next.tokenRevision).toBe(2);
    await expect(store.beginMcpRefresh(input)).rejects.toThrow(M.McpRegistryConflictError);
  });
  it("never rebinds a retained authorization idempotency key after disconnect advances the epoch", async () => {
    const store = new MemorySessionStore(); await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject)); const first = await mcpFixtureBegin(store, owner, subject, "retained-key");
    const engine = Reflect.get(store, "mcpRegistryStore"), index = Reflect.get(engine, "replayIndex") as Map<string, M.McpRegistryReplay>;
    const key = M.mcpRegistryMutationReplaySelection(first.input, M.MCP_REGISTRY_INPUT_FIELDS.begin)!.keySha256, before = JSON.stringify(index.get(key));
    await store.setMcpUserAuthorizationState({ ...first.ref, expectedAuthorizationEpoch: 1, state: "disconnected", idempotencyKey: "disconnect" });
    expect(JSON.stringify(index.get(key))).toBe(before);
    await expect(mcpFixtureBegin(store, owner, subject, "retained-key")).rejects.toThrow(M.McpRegistryConflictError);
    expect(JSON.stringify(index.get(key))).toBe(before);
    const next = await mcpFixtureExchange(store, owner, subject, "new-key"); expect(next.authorization.authorizationEpoch).toBe(3);
  });
  it("never reclaims unknown refresh and rejects a late result after disconnect", async () => {
    const store = new MemorySessionStore(); await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject)); const g = await mcpFixtureExchange(store, owner, subject);
    const input = { ...g.ref, expectedAuthorizationEpoch: 1, expectedTokenRevision: 1, expectedCredentialVersionId: g.authorization.credentialVersionId!, operationTimeoutMs: 30000 };
    const claim = await store.beginMcpRefresh(input);
    const unknown = await store.finishMcpCredentialOperation({ ...g.ref, operationId: claim.operation.operationId, claimToken: claim.claimToken, result: { kind: "outcome_unknown" } });
    expect(unknown.credentialVersionId).toBeNull(); expect(unknown.tokenRevision).toBe(1); expect(unknown.authorizationEpoch).toBe(1);
    const engine = Reflect.get(store, "mcpRegistryStore"), images = Reflect.get(engine, "images") as Map<string, M.McpRegistryImage>;
    expect(images.get(M.mcpRegistrationId(owner, "example"))?.materials.find(m => m.materialId === g.authorization.credentialVersionId)?.envelope).toBeNull();
    await expect(store.beginMcpRefresh(input)).rejects.toThrow(M.McpRegistryConflictError);
    expect(await store.getMcpRuntimeAuthorization(g.ref)).toBeNull();
    const disconnected = await store.setMcpUserAuthorizationState({ ...g.ref, expectedAuthorizationEpoch: 1, state: "disconnected", idempotencyKey: "disconnect" });
    await expect(store.finishMcpCredentialOperation({ ...g.ref, operationId: claim.operation.operationId, claimToken: claim.claimToken,
      result: { kind: "success", material: mcpFixtureMaterial(claim.resultAad), scopes: ["read"], expiresInMs: 60000 } })).rejects.toThrow(M.McpRegistryConflictError);
    expect(disconnected.authorizationEpoch).toBe(2); expect(await store.getMcpRuntimeAuthorization(g.ref)).toBeNull();
  });
  it("publishes AS-client material with configuration, preserves it on disable and rejects missing material atomically", async () => {
    const store = new MemorySessionStore(), authConfig = mcpFixtureConfig.authentication;
    if (authConfig.kind !== "oauth") throw new Error("fixture");
    const config: M.McpRegistrationConfig = { ...mcpFixtureConfig, authentication: { ...authConfig, clientAuthentication: "client_secret_basic" } };
    const input = mcpFixtureWrite(owner, subject, 0, "basic", config);
    await expect(store.upsertMcpRegistration({ ...input, clientSecret: null })).rejects.toThrow(M.McpRegistryIntegrityError);
    expect(await store.getMcpRegistration({ access: input.access, owner, name: "example" })).toBeNull();
    await store.upsertMcpRegistration(input);
    const g = await mcpFixtureExchange(store, owner, subject); expect(Boolean(g.claim.clientMaterial?.envelope)).toBe(true);
    await store.setMcpRegistrationState({ access: input.access, owner, name: "example", expectedRevision: 1, idempotencyKey: "disable", state: "disabled" });
    expect(await store.getMcpRuntimeAuthorization(g.ref)).toBeNull();
    await store.setMcpRegistrationState({ access: input.access, owner, name: "example", expectedRevision: 2, idempotencyKey: "enable", state: "enabled" });
    expect(Boolean((await mcpFixtureExchange(store, owner, subject, "reauthorize")).claim.clientMaterial?.envelope)).toBe(true);
  });
  it("prevents CAS/ABA and cloned authority without changing the current slot", async () => {
    const store = new MemorySessionStore(), input = mcpFixtureWrite(owner, subject); await store.upsertMcpRegistration(input);
    await expect(store.upsertMcpRegistration({ ...input, access: structuredClone(input.access) })).rejects.toThrow(M.McpRegistryIntegrityError);
    await expect(store.upsertMcpRegistration(mcpFixtureWrite(owner, subject, 0, "other"))).rejects.toThrow(M.McpRegistryConflictError);
    const gone = await store.setMcpRegistrationState({ access: input.access, owner, name: "example", expectedRevision: 1, idempotencyKey: "delete", state: "deleted" });
    await expect(store.upsertMcpRegistration(input)).rejects.toThrow(M.McpRegistryConflictError);
    expect((await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject, gone.revision, "recreate", mcpFixtureConfig, 2))).slot.generation).toBe(2);
  });
  it("returns the exact immutable version atomically and never substitutes a later publication on old replay", async () => {
    const store = new MemorySessionStore(), input = mcpFixtureWrite(owner, subject), first = await store.upsertMcpRegistration(input);
    const second = await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject, 1, "second", { ...mcpFixtureConfig, description: "Second immutable configuration" }));
    expect(first.slot.revision).toBe(1); expect(first.version.configVersionId).toBe(first.slot.currentVersionId); expect(first.version.config.description).toBe("Fixture server");
    expect(second.slot.revision).toBe(2); expect(second.version.configVersionId).toBe(second.slot.currentVersionId); expect(second.version.configVersionId).not.toBe(first.version.configVersionId);
    await expect(store.upsertMcpRegistration(input)).rejects.toThrow(M.McpRegistryConflictError);
  });
  it("does not publish if outbound serialization or a late Map mutation throws", async () => {
    const store = new MemorySessionStore(), input = mcpFixtureWrite(owner, subject), clone = globalThis.structuredClone;
    vi.spyOn(globalThis, "structuredClone").mockImplementation(<T>(v: T, options?: Parameters<typeof structuredClone>[1]): T => {
      if (v && typeof v === "object" && "slot" in v && "version" in v) throw new Error("injected outbound failure"); return clone(v, options);
    });
    await expect(store.upsertMcpRegistration(input)).rejects.toThrow("injected outbound failure"); vi.restoreAllMocks();
    expect(await store.getMcpRegistration({ access: input.access, owner, name: "example" })).toBeNull();
    const engine = Reflect.get(store, "mcpRegistryStore"), images = Reflect.get(engine, "images") as Map<string, unknown>, set = images.set.bind(images);
    vi.spyOn(images, "set").mockImplementation((key, value) => { set(key, value); throw new Error("injected late publication"); });
    await expect(store.upsertMcpRegistration(input)).rejects.toThrow("injected late publication"); vi.restoreAllMocks();
    expect(await store.getMcpRegistration({ access: input.access, owner, name: "example" })).toBeNull();
  });
  it("rechecks actual user lifecycle on cached refs and callback lookup", async () => {
    const store = new MemorySessionStore(); await store.upsertMcpRegistration(mcpFixtureWrite(owner, subject)); const g = await mcpFixtureBegin(store, owner, subject);
    await store.requestUserErasure({ requestId: newErasureRequestId(), ...subject, requestedByKeyId: "test", idempotencyKey: "erase", requestHash: userErasureRequestHash(subject.tenantId, subject.userId), atMs: Date.now() });
    await expect(store.getMcpAuthorizationContext(g.ref)).rejects.toThrow(SubjectDeletingError);
    await expect(store.lookupMcpAuthorizationState(g.pending.stateSha256)).rejects.toThrow(SubjectDeletingError);
  });
  it("rejects altered AAD/purpose and protocol-invalid subject without invoking getters", () => {
    expect(() => M.createMcpRegistryAccess({ principal: { tenantId: "中".repeat(129), userId: "user" }, owner, authority: "user_self", access: "runtime" })).toThrow(M.McpRegistryIntegrityError);
    expect(() => M.createMcpRegistryAccess({ principal: { ...subject, userId: "*" }, owner, authority: "user_self", access: "runtime" })).toThrow(M.McpRegistryIntegrityError);
    let reads = 0; const bad = { ...owner, get userId() { reads++; throw new Error("secret-canary"); } };
    expect(() => M.validateMcpRegistrationOwner(bad)).toThrow(M.McpRegistryIntegrityError); expect(reads).toBe(0);
    expect(() => M.mcpRegistrationVersionId(owner, "example", -1, randomUUID())).toThrow(M.McpRegistryIntegrityError);
  });
});
