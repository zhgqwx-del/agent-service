import { createHash, randomUUID } from "node:crypto";
import {
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type ProviderConfig,
} from "@agent-service/protocol";
import { type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialSourceConflictError,
  MysqlSessionStore,
  TenantCredentialResponsibilityIntegrityError,
  TenantErasureIntegrityError,
  createProviderByokSecretAdmission,
  newErasureRequestId,
  tenantErasureRequestHash,
  type TenantCredentialRevocationClaim,
  type TenantRuntimeRevocationClaim,
} from "../src/index.js";
import { CurrentMysqlRuntimeOwner, type CurrentMysqlInspection } from "./fixtures/current-mysql-runtime.js";


// Current-schema isolated fixtures include the published 0058/0059 responsibility guards.
// No business database, real external adapter, provider revocation, or credential zeroization is exercised.
const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(name)) {
    throw new Error("MYSQL_TEST_URL must identify a disposable MySQL test database");
  }
  return url;
}

function provider(tenantId: string, patch: Partial<ProviderConfig> = {}): ProviderConfig {
  const now = Date.now();
  return {
    tenantId, id: "provider", api: "openai-completions",
    baseUrl: "https://byok-fixture.invalid/v1", apiKeyRef: "secret:byok-fixture",
    headers: {}, models: [{ id: "model", contextWindow: 1_000,
      maxOutputTokens: 10, input: ["text"], reasoning: false }],
    quota: {}, fallback: [], createdAtMs: now, updatedAtMs: now, ...patch,
  };
}
function secret(label: string) {
  return { ciphertext: Buffer.from(`encrypted-test-${label}`), keyId: "platform-shared-key" };
}
async function trustedWrite(
  store: MysqlSessionStore,
  config: ProviderConfig,
  expectedSourceRevision: number | null,
  encrypted = secret(randomUUID()),
): Promise<ProviderConfig> {
  const secretAdmission = createProviderByokSecretAdmission({
    tenantId: config.tenantId, providerId: config.id, expectedSourceRevision,
    secret: encrypted,
  });
  return store.upsertProviderConfigWithResponsibility({
    config, expectedSourceRevision, secret: encrypted, secretAdmission,
  });
}
async function requestAndClaim(store: MysqlSessionStore, tenantId: string, leaseMs = 120_000) {
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({
    requestId, tenantId, requestedByKeyId: "responsibility-admin",
    idempotencyKey: `responsibility-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now(),
  });
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    const claim = (await store.claimTenantCredentialRevocations({
      limit: 100, leaseMs, claimToken: `responsibility-${randomUUID()}`,
    })).find((row) => row.requestId === requestId);
    if (claim) return { requestId, claim };
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("isolated T3a claim was not created");
}
function credentialAuthorization(claim: TenantCredentialRevocationClaim) {
  return { requestId: claim.requestId, tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken };
}
function runtimeAuthorization(claim: TenantRuntimeRevocationClaim) {
  return { requestId: claim.requestId, tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken };
}
async function completeRuntime(store: MysqlSessionStore, requestId: string) {
  expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 100 })).toBe(1);
  const claim = (await store.claimTenantRuntimeRevocations({
    limit: 100, leaseMs: 120_000, claimToken: `runtime-${randomUUID()}`,
  })).find((row) => row.requestId === requestId);
  expect(claim).toBeDefined();
  const targetBody = {
    targetSha256: tenantRuntimeTargetSha256("http://isolated-runner.invalid:8080"),
    runnerId: "isolated-runner", bootId: "isolated-boot",
    requestId: claim!.requestId, tenantId: claim!.tenantId,
    subjectGeneration: claim!.subjectGeneration, t3aReceiptSha256: claim!.t3aReceiptSha256,
    cacheEntryCountBefore: 1, cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 0, activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 0, activeTurnCountAfter: 0 as const,
    completedAtMs: Date.now(),
  };
  const targets = [{ ...targetBody, receiptSha256: tenantRuntimeLocalReceiptSha256(targetBody) }];
  const receipt = await store.completeTenantRuntimeRevocation(
    runtimeAuthorization(claim!),
    { targets, fleetSha256: tenantRuntimeFleetSha256(targets),
      targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets) },
  );
  expect(receipt).not.toBeNull();
  return receipt!;
}
async function rawDigest(conn: CurrentMysqlInspection, tenantId: string, requestId?: string): Promise<string> {
  const tables = [
    ["provider_configs", "tenant_id", tenantId],
    ["tenant_credential_provider_slots", "tenant_id", tenantId],
    ["tenant_credential_versions", "tenant_id", tenantId],
    ["tenant_credential_target_dispositions", "tenant_id", tenantId],
    ["tenant_credential_responsibility_sources", "tenant_id", tenantId],
    ["tenant_credential_responsibility_entries", "tenant_id", tenantId],
    ["tenant_credential_responsibility_receipts", "tenant_id", tenantId],
    ["tenant_credential_inventory_receipts", "tenant_id", tenantId],
    ["tenant_credential_revocation_receipts", "tenant_id", tenantId],
    ["tenant_credential_revocation_jobs", "tenant_id", tenantId],
    ["tenants", "tenant_id", tenantId],
    ["api_keys", "tenant_id", tenantId],
  ] as const;
  const digest = createHash("sha256");
  for (const [table, column, key] of tables) {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT * FROM \`${table}\` WHERE \`${column}\`=?`, [key],
    );
    digest.update(table).update("\0").update(JSON.stringify(rows)).update("\0");
  }
  if (requestId) digest.update(requestId);
  return digest.digest("hex");
}
async function sourceRows(conn: CurrentMysqlInspection, tenantId: string) {
  const [rows] = await conn.query<(RowDataPacket & { source_json: unknown })[]>(
    `SELECT source_json FROM tenant_credential_responsibility_sources
      WHERE tenant_id=? ORDER BY source_revision`, [tenantId],
  );
  return rows.map((row) => (typeof row.source_json === "string"
    ? JSON.parse(row.source_json) : row.source_json) as Record<string, unknown>);
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore BYOK responsibility source and local T3a/T3b", () => {
    let owner: CurrentMysqlRuntimeOwner | undefined;
    let setupComplete = false;
    beforeAll(async () => { disposableBase(BASE_MYSQL_URL); });
    beforeEach(async ({ signal }) => {
      owner = new CurrentMysqlRuntimeOwner(BASE_MYSQL_URL);
      setupComplete = false;
      const abort = () => { void owner?.close({ successful: false }).catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) abort();
        await owner.prepare();
        if (signal.aborted) throw signal.reason;
        setupComplete = true;
      } finally { signal.removeEventListener("abort", abort); }
    });
    afterEach(async ({ task, signal }) => {
      const abort = () => { void owner?.close({ successful: false }).catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await owner?.close({ successful: setupComplete && !signal.aborted && task.result?.state === "pass"
          && !task.result.errors?.length && (task.result.retryCount ?? 0) === 0 && (task.result.repeatCount ?? 0) === 0 });
      } finally { signal.removeEventListener("abort", abort); setupComplete = false; }
    });
    afterAll(async () => { await owner?.close({ successful: false }); });

    it("preserves inactive provider CRUD without publishing responsibility source", async () => {
      const store = await owner!.openStore(4);
      const conn = await owner!.openInspection();
      const tenantId = `tenant-inactive-${randomUUID()}`;
      try {
        expect((await store.readTenantCredentialTrackingCutover()).controlGeneration).toBe(0);
        await trustedWrite(store, provider(tenantId), null, secret("inactive"));
        expect(await store.getProviderConfig(tenantId, "provider"))
          .toMatchObject({ credentialSourceRevision: 1,
            secret: { ciphertext: secret("inactive").ciphertext, keyId: "platform-shared-key" } });
        expect(await sourceRows(conn, tenantId)).toEqual([]);

        await store.upsertProviderConfigWithResponsibility({
          config: provider(tenantId, { name: "inactive edit" }), expectedSourceRevision: 1,
        });
        expect(await store.getProviderConfig(tenantId, "provider"))
          .toMatchObject({ credentialSourceRevision: 2, config: { name: "inactive edit" } });
        expect(await sourceRows(conn, tenantId)).toEqual([]);

        expect(await store.deleteProviderConfig(tenantId, "provider")).toBe(true);
        expect(await store.getProviderConfig(tenantId, "provider")).toBeNull();
        expect(await sourceRows(conn, tenantId)).toEqual([]);
        expect((await store.readTenantCredentialTrackingCutover()).controlGeneration).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("publishes an admitted source then an exact T3a snapshot and local T3b readiness", async () => {
      const store = await owner!.openStore(4);
      const conn = await owner!.openInspection();
      const tenantId = `tenant-byok-${randomUUID()}`;
      try {
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
        await trustedWrite(store, provider(tenantId), null, secret("first"));
        const source = await sourceRows(conn, tenantId);
        expect(source).toHaveLength(1);
        expect(source[0]).toMatchObject({ sourceRevision: 1, apiKeySource: "new_byok",
          apiKeyResponsibility: "customer_managed",
          envelopeKeyResponsibility: "platform_shared_not_tenant_deletable" });
        const r = await requestAndClaim(store, tenantId);
        expect(await store.getTenantCredentialResponsibilityReadiness(tenantId, r.requestId))
          .toMatchObject({ status: "unknown", localDatabase: "not_cleared", versionCount: null });
        const t3a = await store.revokeTenantCredentialMaterial(credentialAuthorization(r.claim));
        expect(t3a).not.toBeNull();
        expect(await store.getProviderConfig(tenantId, "provider")).toBeNull();
        const [entries] = await conn.query<RowDataPacket[]>(
          "SELECT * FROM tenant_credential_responsibility_entries WHERE tenant_id=? AND request_id=?",
          [tenantId, r.requestId],
        );
        expect(entries).toHaveLength(1);
        const [receipts] = await conn.query<RowDataPacket[]>(
          "SELECT * FROM tenant_credential_responsibility_receipts WHERE tenant_id=? AND request_id=?",
          [tenantId, r.requestId],
        );
        expect(receipts).toHaveLength(1);
        expect(await store.getTenantCredentialResponsibilityReadiness(tenantId, r.requestId))
          .toMatchObject({ status: "awaiting_runtime_drain", localDatabase: "cleared",
            trackedRuntimeReferences: "not_drained", versionCount: 1,
            customerManagedApiKeyCount: 1, unknownMaterialCount: 0 });
        const t3b = await completeRuntime(store, r.requestId);
        expect(await store.getTenantCredentialResponsibilityReadiness(tenantId, r.requestId))
          .toMatchObject({ status: "local_responsibility_observed",
            t3aReceiptSha256: t3a!.receiptSha256, t3bReceiptSha256: t3b.receiptSha256,
            localDatabase: "cleared", trackedRuntimeReferences: "dropped_not_zeroized",
            remoteCredentials: "customer_responsibility_recorded",
            sharedKeys: "platform_shared_not_tenant_deletable", backupCopies: "unknown",
            otherCopies: "unknown", executionReady: false, externalAuthorityVerified: false,
            allDomainsComplete: false, contentPurgeExecuted: false });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("requires original encrypted admission and inherits only the exact prior envelope", async () => {
      const store = await owner!.openStore(4);
      const conn = await owner!.openInspection();
      const tenantId = `tenant-admission-${randomUUID()}`;
      try {
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
        const config = provider(tenantId);
        const encrypted = secret("admitted");
        const token = createProviderByokSecretAdmission({
          tenantId, providerId: config.id, expectedSourceRevision: null, secret: encrypted,
        });
        const empty = await rawDigest(conn, tenantId);
        await expect(store.upsertProviderConfigWithResponsibility({
          config, secret: encrypted, expectedSourceRevision: null,
        })).rejects.toBeInstanceOf(TenantCredentialResponsibilityIntegrityError);
        await expect(store.upsertProviderConfigWithResponsibility({
          config, secret: { ciphertext: Buffer.from(encrypted.ciphertext), keyId: encrypted.keyId },
          secretAdmission: token, expectedSourceRevision: null,
        })).rejects.toBeInstanceOf(TenantCredentialResponsibilityIntegrityError);
        expect(await rawDigest(conn, tenantId)).toBe(empty);
        await store.upsertProviderConfigWithResponsibility({
          config, secret: encrypted, secretAdmission: token, expectedSourceRevision: null,
        });
        await store.upsertProviderConfigWithResponsibility({
          config: provider(tenantId, { headers: { "x-private-header": "still-unknown" } }),
          expectedSourceRevision: 1,
        });
        const sources = await sourceRows(conn, tenantId);
        expect(sources).toHaveLength(2);
        expect(sources[1]).toMatchObject({ apiKeySource: "inherited_byok",
          inheritedFromCredentialVersionId: sources[0]!.credentialVersionId,
          inheritedFromResponsibilityReceiptSha256: sources[0]!.receiptSha256,
          secretEnvelopeSha256: sources[0]!.secretEnvelopeSha256,
          apiKeyResponsibility: "customer_managed",
          customHeadersResponsibility: "unknown" });
        const r = await requestAndClaim(store, tenantId);
        await store.revokeTenantCredentialMaterial(credentialAuthorization(r.claim));
        expect(await store.getTenantCredentialResponsibilityReadiness(tenantId, r.requestId))
          .toMatchObject({ status: "unknown", remoteCredentials: "unknown",
            customerManagedApiKeyCount: 2, unknownMaterialCount: 1 });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("does not call a known BYOK version complete when tenant pre-cutover history is unknown", async () => {
      const store = await owner!.openStore(4);
      const tenantId = `tenant-legacy-history-${randomUUID()}`;
      try {
        await store.upsertProviderConfig(provider(tenantId, { apiKeyRef: undefined }));
        expect((await store.getProviderConfig(tenantId, "provider"))?.credentialSourceRevision)
          .toBe(1);
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
        // The real 0026 activation republishes each legacy slot under a new
        // CAS revision. Observe that boundary rather than reusing revision 1.
        const activated = await store.getProviderConfig(tenantId, "provider");
        expect(activated?.credentialSourceRevision).toBe(2);
        await trustedWrite(store, provider(tenantId), activated!.credentialSourceRevision!,
          secret("post-cutover"));
        const r = await requestAndClaim(store, tenantId);
        await store.revokeTenantCredentialMaterial(credentialAuthorization(r.claim));
        const readiness = await store.getTenantCredentialResponsibilityReadiness(
          tenantId, r.requestId,
        );
        expect(readiness).toMatchObject({ status: "unknown", localDatabase: "cleared",
          remoteCredentials: "unknown", versionCount: 1,
          customerManagedApiKeyCount: 1, unknownMaterialCount: 0,
          allDomainsComplete: false });
      } finally {
        await store.close();
      }
    });

    it("rolls the 0026 write and late responsibility source insertion back together", async () => {
      const store = await owner!.openStore(4);
      const conn = await owner!.openInspection();
      const tenantId = `tenant-source-rollback-${randomUUID()}`;
      const trigger = "trg_test_byok_source_late_failure";
      try {
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
        const before = await rawDigest(conn, tenantId);
        await conn.query(`CREATE TRIGGER ${trigger} AFTER INSERT ON tenant_credential_responsibility_sources
          FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated BYOK source failure'`);
        await expect(trustedWrite(store, provider(tenantId), null))
          .rejects.toThrow("isolated BYOK source failure");
        expect(await rawDigest(conn, tenantId)).toBe(before);
        expect(await sourceRows(conn, tenantId)).toEqual([]);
        await conn.query(`DROP TRIGGER \`${trigger}\``);
        await trustedWrite(store, provider(tenantId), null);
        expect(await sourceRows(conn, tenantId)).toHaveLength(1);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("rolls local credential deletion, old receipts, and the new snapshot back after a late insert", async () => {
      const store = await owner!.openStore(4);
      const conn = await owner!.openInspection();
      const tenantId = `tenant-snapshot-rollback-${randomUUID()}`;
      const trigger = "trg_test_byok_snapshot_late_failure";
      try {
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
        await trustedWrite(store, provider(tenantId), null);
        const r = await requestAndClaim(store, tenantId);
        const before = await rawDigest(conn, tenantId, r.requestId);
        await conn.query(`CREATE TRIGGER ${trigger} AFTER INSERT ON tenant_credential_responsibility_receipts
          FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated BYOK snapshot failure'`);
        await expect(store.revokeTenantCredentialMaterial(credentialAuthorization(r.claim)))
          .rejects.toThrow("isolated BYOK snapshot failure");
        expect(await rawDigest(conn, tenantId, r.requestId)).toBe(before);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, r.requestId)).toBeNull();
        expect(await store.getTenantCredentialInventoryReceipt(tenantId, r.requestId)).toBeNull();
        expect(await store.getTenantCredentialRevocationJob(tenantId, r.requestId))
          .toMatchObject({ phase: "queued", claimToken: r.claim.claimToken });
        await conn.query(`DROP TRIGGER \`${trigger}\``);
        expect(await store.revokeTenantCredentialMaterial(credentialAuthorization(r.claim)))
          .not.toBeNull();
        expect(await store.getTenantCredentialResponsibilityReadiness(tenantId, r.requestId))
          .toMatchObject({ localDatabase: "cleared", versionCount: 1 });
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("rolls a reached new snapshot insertion back when its real DB claim lease expires", async () => {
      const store = await owner!.openStore(4);
      const conn = await owner!.openInspection();
      const tenantId = `tenant-late-lease-${randomUUID()}`;
      const trigger = "trg_test_byok_snapshot_lease_delay";
      try {
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
        await trustedWrite(store, provider(tenantId), null);
        const r = await requestAndClaim(store, tenantId, 3_000);
        const before = await rawDigest(conn, tenantId, r.requestId);
        await conn.query(`CREATE TRIGGER ${trigger} AFTER INSERT ON tenant_credential_responsibility_receipts
          FOR EACH ROW BEGIN DO SLEEP(4); END`);
        const started = performance.now();
        await expect(store.revokeTenantCredentialMaterial(credentialAuthorization(r.claim)))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(performance.now() - started).toBeGreaterThanOrEqual(3_500);
        expect(await rawDigest(conn, tenantId, r.requestId)).toBe(before);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, r.requestId)).toBeNull();
        expect(await store.getTenantCredentialInventoryReceipt(tenantId, r.requestId)).toBeNull();
        await conn.query(`DROP TRIGGER \`${trigger}\``);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("keeps exactly one concurrent admitted CAS winner and no orphan source", async () => {
      const left = await owner!.openStore(4);
      const right = await owner!.openStore(4);
      const conn = await owner!.openInspection();
      const tenantId = `tenant-cas-${randomUUID()}`;
      try {
        await left.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
        const results = await Promise.allSettled([
          trustedWrite(left, provider(tenantId), null, secret("left")),
          trustedWrite(right, provider(tenantId), null, secret("right")),
        ]);
        expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
        const rejected = results.filter((row): row is PromiseRejectedResult => row.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.reason).toBeInstanceOf(CredentialSourceConflictError);
        expect(await sourceRows(conn, tenantId)).toHaveLength(1);
        const [versions] = await conn.query<RowDataPacket[]>(
          "SELECT * FROM tenant_credential_versions WHERE tenant_id=?", [tenantId],
        );
        expect(versions).toHaveLength(1);
        const current = await left.getProviderConfig(tenantId, "provider");
        expect(current?.credentialSourceRevision).toBe(1);
      } finally {
        await conn.end();
        await Promise.allSettled([left.close(), right.close()]);
      }
    });
  });
} else {
  describe("MysqlSessionStore BYOK responsibility source and local T3a/T3b", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 and use a disposable MySQL fixture", () => {});
  });
}
