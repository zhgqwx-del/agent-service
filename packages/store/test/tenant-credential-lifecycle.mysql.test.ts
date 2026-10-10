import { createHash, randomUUID } from "node:crypto";
import {
  type ProviderConfig,
  type TenantAuthPolicy,
} from "@agent-service/protocol";
import mysql, {
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  CredentialSourceConflictError,
  MysqlSessionStore,
  TenantErasureIntegrityError,
  newErasureRequestId,
  tenantCredentialInventoryReceiptSha256,
  tenantCredentialProviderSlotEvidenceSha256,
  tenantCredentialVersionEvidenceSha256,
  tenantErasureRequestHash,
  type TenantCredentialRevocationAuthorization,
  type TenantCredentialRevocationClaim,
} from "../src/index.js";
import { mkSession } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

const AUTH_POLICY: TenantAuthPolicy = {
  mode: "end_user_token",
  tokenHeader: "x-end-user-token",
  verifier: {
    kind: "jwt",
    hs256: true,
    algorithms: ["HS256"],
    subjectClaim: "sub",
    clockToleranceSec: 0,
  },
};

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create credential lifecycle fixture from base database "${database}": `
      + "MYSQL_TEST_URL must name a test database",
    );
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function digest(label: string): string {
  return createHash("sha256").update(`${label}:${randomUUID()}`).digest("hex");
}

function provider(
  tenantId: string,
  providerId: string,
  marker?: string,
): ProviderConfig {
  const now = Date.now();
  return {
    tenantId,
    id: providerId,
    api: "openai-completions",
    baseUrl: "https://credential-lifecycle.invalid/v1",
    headers: marker === undefined ? {} : { "x-lifecycle-marker": marker },
    models: [{
      id: "fixture-model",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      input: ["text"],
      reasoning: false,
    }],
    quota: {},
    fallback: [],
    createdAtMs: now,
    updatedAtMs: now,
  };
}

async function seedTenant(store: MysqlSessionStore, tenantId: string): Promise<void> {
  await store.createSession(mkSession(tenantId, `user-${randomUUID()}`));
}

async function activateTracking(store: MysqlSessionStore): Promise<void> {
  const activated = await store.activateTenantCredentialTrackingCutover({
    expectedControlGeneration: 0,
  });
  expect(activated).toMatchObject({ controlGeneration: 1 });
  expect(activated.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
}

function authorization(
  claim: TenantCredentialRevocationClaim,
): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

async function requestAndClaim(
  store: MysqlSessionStore,
  tenantId: string,
): Promise<{
  requestId: string;
  authorization: TenantCredentialRevocationAuthorization;
}> {
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({
    requestId,
    tenantId,
    requestedByKeyId: "credential-lifecycle-admin",
    idempotencyKey: `credential-lifecycle-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  });
  const claimToken = `credential-lifecycle-worker-${randomUUID()}`;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const claim = (await store.claimTenantCredentialRevocations({
      limit: 100,
      leaseMs: 60_000,
      claimToken,
    })).find((candidate) => candidate.requestId === requestId);
    if (claim) return { requestId, authorization: authorization(claim) };
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("credential lifecycle T3a fixture was not claimable");
}

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

async function rawCredentialState(conn: Connection, tenantId: string): Promise<unknown> {
  const [tenantRows] = await conn.query<RowDataPacket[]>(
    `SELECT tenant_id, auth_policy, HEX(auth_secret_cipher) AS auth_secret_cipher_hex,
            auth_secret_key_id, auth_write_generation, auth_credential_version_id,
            auth_credential_updated_at_db_ms
       FROM tenants WHERE tenant_id=?`,
    [tenantId],
  );
  const [providerRows] = await conn.query<RowDataPacket[]>(
    `SELECT tenant_id, provider_id, config, HEX(secret_cipher) AS secret_cipher_hex,
            secret_key_id, credential_slot_id_sha256, credential_write_generation,
            credential_version_id
       FROM provider_configs WHERE tenant_id=? ORDER BY provider_id`,
    [tenantId],
  );
  const [apiKeyRows] = await conn.query<RowDataPacket[]>(
    `SELECT key_hash, key_id, tenant_id, revoked_at_ms, scopes
       FROM api_keys WHERE tenant_id=? ORDER BY key_hash`,
    [tenantId],
  );
  const [subjectRows] = await conn.query<RowDataPacket[]>(
    `SELECT * FROM tenant_credential_tracking_subjects
      WHERE tenant_id=? ORDER BY tenant_id`,
    [tenantId],
  );
  const [slotRows] = await conn.query<RowDataPacket[]>(
    `SELECT * FROM tenant_credential_provider_slots
      WHERE tenant_id=? ORDER BY slot_id_sha256`,
    [tenantId],
  );
  const [versionRows] = await conn.query<RowDataPacket[]>(
    `SELECT * FROM tenant_credential_versions
      WHERE tenant_id=? ORDER BY credential_version_id`,
    [tenantId],
  );
  const [targetRows] = await conn.query<RowDataPacket[]>(
    `SELECT credential_version_id, tenant_id, domain, disposition, adapter_protocol,
            HEX(target_reference_cipher) AS target_reference_cipher_hex,
            target_reference_key_id, target_reference_cipher_sha256,
            target_reference_sha256, captured_at_db_ms, evidence_sha256
       FROM tenant_credential_target_dispositions
      WHERE tenant_id=? ORDER BY credential_version_id, domain`,
    [tenantId],
  );
  return normalize({
    tenants: tenantRows,
    providers: providerRows,
    apiKeys: apiKeyRows,
    subjects: subjectRows,
    slots: slotRows,
    versions: versionRows,
    targets: targetRows,
  });
}

async function rawLifecycleMutationState(conn: Connection, tenantId: string): Promise<unknown> {
  const [providerRows] = await conn.query<RowDataPacket[]>(
    `SELECT tenant_id, provider_id, credential_slot_id_sha256,
            credential_write_generation, credential_version_id
       FROM provider_configs WHERE tenant_id=? ORDER BY provider_id`,
    [tenantId],
  );
  const [slotRows] = await conn.query<RowDataPacket[]>(
    `SELECT tenant_id, slot_id_sha256, write_generation, source_present,
            current_credential_version_id, updated_at_db_ms, evidence_sha256
       FROM tenant_credential_provider_slots
      WHERE tenant_id=? ORDER BY slot_id_sha256`,
    [tenantId],
  );
  const [versionRows] = await conn.query<RowDataPacket[]>(
    `SELECT credential_version_id, tenant_id, slot_kind, slot_id_sha256,
            retired_at_db_ms, retire_reason, evidence_sha256
       FROM tenant_credential_versions
      WHERE tenant_id=? ORDER BY credential_version_id`,
    [tenantId],
  );
  return normalize({ providers: providerRows, slots: slotRows, versions: versionRows });
}

async function dropBeforeUpdateGuards(
  conn: Connection,
  tables: readonly string[],
): Promise<void> {
  const placeholders = tables.map(() => "?").join(",");
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT trigger_name FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND action_timing='BEFORE'
        AND event_manipulation='UPDATE' AND event_object_table IN (${placeholders})`,
    [...tables],
  );
  for (const row of rows) {
    const trigger = String(row.trigger_name ?? row.TRIGGER_NAME);
    if (!/^[A-Za-z0-9_]+$/.test(trigger)) throw new Error("unsafe trigger name in test fixture");
    await conn.query(`DROP TRIGGER \`${trigger}\``);
  }
}

async function waitForTableLockWaiter(
  conn: Connection,
  database: string,
  table: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [rows] = await conn.query<(RowDataPacket & { waiters: number })[]>(
      `SELECT COUNT(DISTINCT waits.REQUESTING_ENGINE_TRANSACTION_ID) AS waiters
         FROM performance_schema.data_lock_waits waits
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA=? AND requested.OBJECT_NAME=?`,
      [database, table],
    );
    if (Number(rows[0]?.waiters ?? 0) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${table} lock waiter`);
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant credential lifecycle", () => {
    let baseUrl: URL;
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";

    beforeAll(async () => {
      baseUrl = assertDisposableTestTarget(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
    });

    beforeEach(async () => {
      database = `agent_service_credential_lifecycle_test_${process.pid}_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      if (!/^agent_service_credential_lifecycle_test_[A-Za-z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated credential lifecycle database name");
      }
      await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(baseUrl, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterEach(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      database = "";
      mysqlUrl = "";
    });

    afterAll(async () => {
      await admin?.end();
    });

    it("keeps inventory reads unavailable until the durable tracking cutover is active", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant-inactive-${randomUUID()}`;
      try {
        await seedTenant(store, tenantId);
        await store.upsertProviderConfig(provider(tenantId, "provider-inactive", "legacy"));
        expect(await store.readTenantCredentialTrackingCutover()).toEqual({
          controlGeneration: 0,
        });
        await expect(store.getTenantCredentialInventorySnapshot(tenantId))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      } finally {
        await store.close();
      }
    });

    it("orders activation before a concurrent new-tenant credential write without deadlock", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const existingTenantId = `tenant-activation-existing-${randomUUID()}`;
      const newTenantId = `tenant-activation-new-${randomUUID()}`;
      const providerId = "provider-created-across-activation";
      let activation: ReturnType<MysqlSessionStore["activateTenantCredentialTrackingCutover"]>
        | undefined;
      let write: ReturnType<MysqlSessionStore["upsertProviderConfig"]> | undefined;
      try {
        await seedTenant(store, existingTenantId);
        await blocker.beginTransaction();
        await blocker.query(
          "SELECT singleton_id FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR UPDATE",
        );

        activation = store.activateTenantCredentialTrackingCutover({
          expectedControlGeneration: 0,
        });
        await waitForTableLockWaiter(
          blocker,
          database,
          "tenant_credential_tracking_cutover",
        );

        write = store.upsertProviderConfig(provider(
          newTenantId,
          providerId,
          "created-across-activation",
        ));
        await waitForTableLockWaiter(blocker, database, "subject_lifecycle");
        await blocker.commit();

        const [activated, written] = await Promise.all([activation, write]);
        expect(activated.controlGeneration).toBe(1);
        expect(written).toMatchObject({ tenantId: newTenantId, id: providerId });
        expect(await store.getProviderConfig(newTenantId, providerId)).toMatchObject({
          config: { tenantId: newTenantId, id: providerId },
          credentialSourceRevision: 1,
        });
        const snapshot = await store.getTenantCredentialInventorySnapshot(newTenantId);
        expect(snapshot.subject).toMatchObject({
          tenantId: newTenantId,
          historyStatus: "complete_since_creation",
          origin: "managed_v1",
        });
        expect(snapshot.providerSlots).toHaveLength(1);
        expect(snapshot.versions).toHaveLength(1);
        expect(snapshot.targetDispositions).toHaveLength(2);
      } finally {
        await blocker.rollback().catch(() => {});
        await Promise.allSettled([
          ...(activation ? [activation] : []),
          ...(write ? [write] : []),
        ]);
        await blocker.end();
        await store.close();
      }
    });

    it("serializes active provider/auth CAS and accepts a same-value auth write", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const tenantId = `tenant-cas-${randomUUID()}`;
      const providerId = "provider-cas";
      const authCipher = Buffer.from("credential-lifecycle-auth");
      try {
        await seedTenant(store, tenantId);
        await store.setTenantAuth(tenantId, AUTH_POLICY, {
          ciphertext: authCipher,
          keyId: "credential-lifecycle-key",
        });
        await store.upsertProviderConfig(provider(tenantId, providerId, "initial"));
        await activateTracking(store);

        const initialSnapshot = await store.getTenantCredentialInventorySnapshot(tenantId);
        const initialSlot = initialSnapshot.providerSlots[0]!;
        const initialVersion = initialSnapshot.versions.find(
          (version) => version.credentialVersionId === initialSlot.currentCredentialVersionId,
        );
        expect(initialVersion).toBeDefined();

        const beforeProvider = await store.getProviderConfig(tenantId, providerId);
        expect(beforeProvider).not.toBeNull();
        const providerRevision = beforeProvider!.credentialSourceRevision;
        const providerResults = await Promise.allSettled([
          store.upsertProviderConfig(
            provider(tenantId, providerId, "writer-a"),
            undefined,
            providerRevision,
          ),
          store.upsertProviderConfig(
            provider(tenantId, providerId, "writer-b"),
            undefined,
            providerRevision,
          ),
        ]);
        expect(providerResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const providerRejected = providerResults.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        expect(providerRejected).toHaveLength(1);
        expect(providerRejected[0]!.reason).toBeInstanceOf(CredentialSourceConflictError);
        expect(providerRejected[0]!.reason).toMatchObject({
          sourceKind: "provider",
          expectedSourceRevision: providerRevision,
          actualSourceRevision: providerRevision + 1,
        });

        const beforeSameValue = await store.getTenant(tenantId);
        expect(beforeSameValue?.authCredentialSourceRevision).toBeTypeOf("number");
        const sameValue = await store.setTenantAuth(
          tenantId,
          AUTH_POLICY,
          undefined,
          beforeSameValue!.authCredentialSourceRevision!,
        );
        expect(sameValue.authCredentialSourceRevision)
          .toBe(beforeSameValue!.authCredentialSourceRevision! + 1);
        expect(sameValue.authSecret?.ciphertext).toEqual(authCipher);

        const authRevision = sameValue.authCredentialSourceRevision!;
        const authResults = await Promise.allSettled([
          store.setTenantAuth(tenantId, AUTH_POLICY, undefined, authRevision),
          store.setTenantAuth(tenantId, AUTH_POLICY, undefined, authRevision),
        ]);
        expect(authResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const authRejected = authResults.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        expect(authRejected).toHaveLength(1);
        expect(authRejected[0]!.reason).toBeInstanceOf(CredentialSourceConflictError);
        expect(authRejected[0]!.reason).toMatchObject({
          sourceKind: "tenant_auth",
          expectedSourceRevision: authRevision,
          actualSourceRevision: authRevision + 1,
        });

        const snapshot = await store.getTenantCredentialInventorySnapshot(tenantId);
        expect(snapshot.authSlot.currentCredentialVersionId).toBeDefined();
        expect(snapshot.providerSlots).toHaveLength(1);
        const currentSlot = snapshot.providerSlots[0]!;
        expect(currentSlot.currentCredentialVersionId).toBeDefined();
        expect(currentSlot.writeGeneration).toBe(initialSlot.writeGeneration + 1);
        expect(currentSlot.updatedAtDbMs).toBeGreaterThan(initialSlot.updatedAtDbMs);
        const retiredInitialVersion = snapshot.versions.find(
          (version) => version.credentialVersionId === initialVersion!.credentialVersionId,
        );
        const currentVersion = snapshot.versions.find(
          (version) => version.credentialVersionId === currentSlot.currentCredentialVersionId,
        );
        expect(retiredInitialVersion?.retiredAtDbMs).toBe(currentSlot.updatedAtDbMs);
        expect(currentVersion?.createdAtDbMs).toBe(currentSlot.updatedAtDbMs);
        expect(currentVersion!.createdAtDbMs).toBeGreaterThan(initialVersion!.createdAtDbMs);
      } finally {
        await store.close();
      }
    });

    it("keeps a permanent provider generation across delete and recreate", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-aba-${randomUUID()}`;
      const providerId = "provider-aba";
      try {
        await seedTenant(store, tenantId);
        await store.upsertProviderConfig(provider(tenantId, providerId));
        await activateTracking(store);
        const before = await store.getProviderConfig(tenantId, providerId);
        expect(before).not.toBeNull();
        const liveRevision = before!.credentialSourceRevision;

        expect(await store.deleteProviderConfig(tenantId, providerId)).toBe(true);
        expect(await store.getProviderConfig(tenantId, providerId)).toBeNull();
        const [deletedSlots] = await conn.query<RowDataPacket[]>(
          `SELECT write_generation, source_present, current_credential_version_id
             FROM tenant_credential_provider_slots WHERE tenant_id=?`,
          [tenantId],
        );
        expect(deletedSlots).toHaveLength(1);
        const deletedRevision = Number(deletedSlots[0]!.write_generation);
        expect(deletedRevision).toBe(liveRevision + 1);
        expect(Number(deletedSlots[0]!.source_present)).toBe(0);
        expect(deletedSlots[0]!.current_credential_version_id).toBeNull();

        await expect(store.upsertProviderConfig(
          provider(tenantId, providerId),
          undefined,
          null,
        )).rejects.toMatchObject({
          sourceKind: "provider",
          expectedSourceRevision: null,
          actualSourceRevision: deletedRevision,
        });
        const recreated = await store.upsertProviderConfig(
          provider(tenantId, providerId),
          undefined,
          deletedRevision,
        );
        expect(recreated.id).toBe(providerId);
        const after = await store.getProviderConfig(tenantId, providerId);
        expect(after?.credentialSourceRevision).toBe(deletedRevision + 1);
        await expect(store.upsertProviderConfig(
          provider(tenantId, providerId),
          undefined,
          liveRevision,
        )).rejects.toBeInstanceOf(CredentialSourceConflictError);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("hides UCA-equivalent raw-different credential reads and cannot revoke their key", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const suffix = randomUUID();
      const tenantId = `tenant-caf\u00e9-${suffix}`;
      const alias = `tenant-cafe\u0301-${suffix}`;
      const providerId = "provider-uca";
      const keyHash = digest("uca-key");
      try {
        await seedTenant(store, tenantId);
        await store.setTenantAuth(tenantId, AUTH_POLICY, {
          ciphertext: Buffer.from("uca-auth"),
          keyId: "uca-auth-key",
        });
        await store.upsertProviderConfig(provider(tenantId, providerId, "uca"));
        await store.createApiKey(tenantId, "uca-api-key", keyHash, ["runtime", "admin"]);
        await activateTracking(store);

        expect(await store.getTenant(alias)).toBeNull();
        expect(await store.getProviderConfig(alias, providerId)).toBeNull();
        expect(await store.listProviderConfigs(alias)).toEqual([]);
        expect(await store.listApiKeys(alias)).toEqual([]);
        expect(await store.revokeApiKey(alias, "uca-api-key")).toBe(false);
        expect(await store.resolveApiKey(keyHash)).toMatchObject({ tenantId, keyId: "uca-api-key" });
        await expect(store.getTenantCredentialInventorySnapshot(alias))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      } finally {
        await store.close();
      }
    });

    it("fails snapshots and rolls T3a back when current version material flags drift", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-material-drift-${randomUUID()}`;
      const providerId = "provider-material-drift";
      try {
        await seedTenant(store, tenantId);
        await store.upsertProviderConfig(provider(tenantId, providerId, "header-material"));
        await activateTracking(store);
        const source = await store.getTenantCredentialInventorySnapshot(tenantId);
        const currentVersionId = source.providerSlots[0]!.currentCredentialVersionId!;
        const currentVersion = source.versions.find(
          (version) => version.credentialVersionId === currentVersionId,
        )!;
        expect(currentVersion).toMatchObject({
          encryptedSecretPresent: false,
          secretKeyIdPresent: false,
          customHeadersPresent: true,
          endpointParametersPresent: false,
        });
        const claim = await requestAndClaim(store, tenantId);

        await dropBeforeUpdateGuards(conn, ["tenant_credential_versions"]);
        const { evidenceSha256: _evidenceSha256, ...currentBody } = currentVersion;
        const tamperedBody = {
          ...currentBody,
          customHeadersPresent: false,
          endpointParametersPresent: true,
        };
        await conn.query(
          `UPDATE tenant_credential_versions
              SET custom_headers_present=FALSE, endpoint_parameters_present=TRUE,
                  evidence_sha256=?
            WHERE tenant_id=? AND credential_version_id=?`,
          [
            tenantCredentialVersionEvidenceSha256(tamperedBody),
            tenantId,
            currentVersionId,
          ],
        );
        const beforeT3a = await rawCredentialState(conn, tenantId);

        await expect(store.getTenantCredentialInventorySnapshot(tenantId))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(store.revokeTenantCredentialMaterial(claim.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await rawCredentialState(conn, tenantId)).toEqual(beforeT3a);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, claim.requestId))
          .toBeNull();
        expect(await store.getTenantCredentialInventoryReceipt(tenantId, claim.requestId))
          .toBeNull();
        expect(await store.getTenantCredentialRevocationJob(tenantId, claim.requestId))
          .toMatchObject({
            phase: "queued",
            claimToken: claim.authorization.claimToken,
          });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back T3a sidecar publication and validates the committed sidecar on reads", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-sidecar-${randomUUID()}`;
      const providerId = "provider-sidecar";
      const failureTrigger = "trg_test_credential_inventory_insert_failure";
      try {
        await seedTenant(store, tenantId);
        await store.setTenantAuth(tenantId, AUTH_POLICY, {
          ciphertext: Buffer.from("sidecar-auth"),
          keyId: "sidecar-auth-key",
        });
        await store.upsertProviderConfig(provider(tenantId, providerId, "sidecar"));
        await store.createApiKey(tenantId, "sidecar-api-key", digest("sidecar-key"), ["admin"]);
        await activateTracking(store);
        const claim = await requestAndClaim(store, tenantId);
        const beforeRows = await rawCredentialState(conn, tenantId);
        const beforeSnapshot = await store.getTenantCredentialInventorySnapshot(tenantId);

        await conn.query(
          `CREATE TRIGGER ${failureTrigger}
             BEFORE INSERT ON tenant_credential_inventory_receipts FOR EACH ROW
             SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected inventory publication failure'`,
        );
        await expect(store.revokeTenantCredentialMaterial(claim.authorization))
          .rejects.toThrow(/injected inventory publication failure/);
        expect(await rawCredentialState(conn, tenantId)).toEqual(beforeRows);
        expect(await store.getTenantCredentialInventorySnapshot(tenantId)).toEqual(beforeSnapshot);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, claim.requestId))
          .toBeNull();
        expect(await store.getTenantCredentialInventoryReceipt(tenantId, claim.requestId))
          .toBeNull();
        expect(await store.getTenantCredentialRevocationJob(tenantId, claim.requestId))
          .toMatchObject({ phase: "queued", claimToken: claim.authorization.claimToken });

        await conn.query(`DROP TRIGGER \`${failureTrigger}\``);
        const t3a = await store.revokeTenantCredentialMaterial(claim.authorization);
        expect(t3a).not.toBeNull();
        const inventory = await store.getTenantCredentialInventoryReceipt(
          tenantId,
          claim.requestId,
        );
        expect(inventory).not.toBeNull();
        const afterSnapshot = await store.getTenantCredentialInventorySnapshot(tenantId);
        expect(inventory).toMatchObject({
          t3aReceiptSha256: t3a!.receiptSha256,
          trackingCutoverEvidenceSha256: (await store.readTenantCredentialTrackingCutover())
            .evidenceSha256,
          subjectCount: 1,
          subjectRootSha256: afterSnapshot.subjectRootSha256,
          providerSlotCount: afterSnapshot.providerSlots.length,
          providerSlotRootSha256: afterSnapshot.providerSlotRootSha256,
          authSlotCount: 1,
          authSlotRootSha256: afterSnapshot.authSlotRootSha256,
          versionCount: afterSnapshot.versions.length,
          versionRootSha256: afterSnapshot.versionRootSha256,
          targetDispositionCount: afterSnapshot.targetDispositions.length,
          targetDispositionRootSha256: afterSnapshot.targetDispositionRootSha256,
          providerSourceCountBefore: 1,
          providerSourcePointerCountBefore: 1,
          authSecretPresentBefore: true,
          authSourcePointerPresentBefore: true,
          storeDbTimestampMs: t3a!.storeDbTimestampMs,
        });
        expect(inventory!.externalCredentialBlockerCount).toBeGreaterThan(0);
        expect(inventory!.kmsKeyBlockerCount).toBeGreaterThan(0);

        const [remaining] = await conn.query<(RowDataPacket & {
          provider_count: number;
          api_key_count: number;
          auth_policy: unknown;
          auth_secret_cipher: Buffer | null;
          auth_secret_key_id: string | null;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM provider_configs WHERE tenant_id=?) AS provider_count,
             (SELECT COUNT(*) FROM api_keys WHERE tenant_id=?) AS api_key_count,
             auth_policy, auth_secret_cipher, auth_secret_key_id
             FROM tenants WHERE tenant_id=?`,
          [tenantId, tenantId, tenantId],
        );
        expect(Number(remaining[0]!.provider_count)).toBe(0);
        expect(Number(remaining[0]!.api_key_count)).toBe(0);
        expect(remaining[0]).toMatchObject({
          auth_policy: null,
          auth_secret_cipher: null,
          auth_secret_key_id: null,
        });

        await dropBeforeUpdateGuards(conn, ["tenant_credential_inventory_receipts"]);
        const { receiptSha256: _receiptSha256, ...inventoryBody } = inventory!;
        const tamperedBody = {
          ...inventoryBody,
          subjectRootSha256: "f".repeat(64),
        };
        await conn.query(
          `UPDATE tenant_credential_inventory_receipts
              SET subject_root_sha256=?, receipt_sha256=?
            WHERE tenant_id=? AND request_id=?`,
          [
            tamperedBody.subjectRootSha256,
            tenantCredentialInventoryReceiptSha256(tamperedBody),
            tenantId,
            claim.requestId,
          ],
        );
        await expect(store.getTenantCredentialInventoryReceipt(tenantId, claim.requestId))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(store.revokeTenantCredentialMaterial(claim.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${failureTrigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("rejects a provider source bound to an auth version without partial retirement", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-wrong-kind-${randomUUID()}`;
      const providerId = "provider-wrong-kind";
      try {
        await seedTenant(store, tenantId);
        await store.setTenantAuth(tenantId, AUTH_POLICY, {
          ciphertext: Buffer.from("wrong-kind-auth"),
          keyId: "wrong-kind-auth-key",
        });
        await store.upsertProviderConfig(provider(tenantId, providerId, "provider-material"));
        await activateTracking(store);

        const [projectionRows] = await conn.query<(RowDataPacket & {
          tenant_id: string;
          credential_slot_id_sha256: string;
          credential_write_generation: number;
          provider_credential_version_id: string;
          auth_credential_version_id: string;
          updated_at_db_ms: number;
        })[]>(
          `SELECT p.tenant_id, p.credential_slot_id_sha256,
                  p.credential_write_generation,
                  p.credential_version_id AS provider_credential_version_id,
                  t.auth_credential_version_id,
                  s.updated_at_db_ms
             FROM provider_configs p
             JOIN tenants t ON t.tenant_id=p.tenant_id
             JOIN tenant_credential_provider_slots s
               ON s.tenant_id=p.tenant_id
              AND s.slot_id_sha256=p.credential_slot_id_sha256
            WHERE p.tenant_id=? AND p.provider_id=?`,
          [tenantId, providerId],
        );
        const projection = projectionRows[0]!;
        const slotIdSha256 = String(projection.credential_slot_id_sha256);
        const writeGeneration = Number(projection.credential_write_generation);
        const providerVersionId = String(projection.provider_credential_version_id);
        const authVersionId = String(projection.auth_credential_version_id);
        const updatedAtDbMs = Number(projection.updated_at_db_ms);
        expect(authVersionId).toMatch(/^[0-9a-f]{64}$/);

        // Simulate privileged corruption while preserving all row-local hashes and FKs. The store
        // must bind a retiring pointer to the expected provider slot, not merely to this tenant.
        await dropBeforeUpdateGuards(conn, [
          "provider_configs",
          "tenant_credential_provider_slots",
        ]);
        const corruptedSlot = {
          tenantId,
          slotIdSha256,
          writeGeneration,
          sourcePresent: true,
          currentCredentialVersionId: authVersionId,
          updatedAtDbMs,
        };
        await conn.query(
          `UPDATE tenant_credential_provider_slots
              SET current_credential_version_id=?, evidence_sha256=?
            WHERE tenant_id=? AND slot_id_sha256=?`,
          [
            authVersionId,
            tenantCredentialProviderSlotEvidenceSha256(corruptedSlot),
            tenantId,
            slotIdSha256,
          ],
        );
        await conn.query(
          `UPDATE provider_configs SET credential_version_id=?
            WHERE tenant_id=? AND provider_id=?`,
          [authVersionId, tenantId, providerId],
        );
        await expect(store.getProviderConfig(tenantId, providerId))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(store.listProviderConfigs(tenantId))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);

        await dropBeforeUpdateGuards(conn, ["tenants"]);
        await conn.query(
          "UPDATE tenants SET auth_credential_version_id=? WHERE tenant_id=?",
          [providerVersionId, tenantId],
        );
        await expect(store.getTenant(tenantId))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const before = await rawLifecycleMutationState(conn, tenantId);

        await expect(store.upsertProviderConfig(
          provider(tenantId, providerId, "must-not-commit"),
          undefined,
          writeGeneration,
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await rawLifecycleMutationState(conn, tenantId)).toEqual(before);
      } finally {
        await conn.end();
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore tenant credential lifecycle", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
