import { createHash, randomUUID } from "node:crypto";
import type { ProviderConfig } from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
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
  MysqlSessionStore,
  TenantErasureIntegrityError,
  newErasureRequestId,
  tenantCredentialTargetExecutionAdapterEvidenceSha256,
  tenantErasureRequestHash,
  type ProviderCredentialTargetReferenceWrite,
  type TenantCredentialRevocationAuthorization,
  type TenantCredentialTargetExecutionAdapterResult,
  type TenantCredentialTargetExecutionAuthorization,
  type TenantCredentialTargetExecutionClaim,
  type TenantCredentialTargetExecutionTarget,
} from "../src/index.js";
import { mkSession } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${database}`);
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function provider(tenantId: string, providerId = "managed-provider"): ProviderConfig {
  const now = Date.now();
  return {
    tenantId,
    id: providerId,
    api: "openai-completions",
    baseUrl: "https://credential-target.invalid/v1",
    apiKeyRef: `secret:${tenantId}:${providerId}`,
    headers: {},
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

function protectedReference(locator: string): ProviderCredentialTargetReferenceWrite {
  const plaintext = Buffer.from(locator);
  const ciphertext = Buffer.concat([Buffer.from("sealed:"), plaintext]);
  return {
    domain: "external_credential",
    disposition: "executable_ref",
    adapterProtocol: "fixture-provider-revoke-v1",
    targetReferenceCipher: ciphertext,
    targetReferenceKeyId: "target-reference-key-v1",
    targetReferenceCipherSha256: sha256(ciphertext),
    targetReferenceSha256: sha256(plaintext),
  };
}

function executionAuthorization(
  claim: TenantCredentialTargetExecutionClaim,
): TenantCredentialTargetExecutionAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    targetExecutionGeneration: claim.targetExecutionGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function revocationAuthorization(claim: {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  claimAttempt: number;
  claimToken: string;
}): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function adapterResult(
  target: TenantCredentialTargetExecutionTarget,
  outcome: "revoked" | "already_absent" = "revoked",
): TenantCredentialTargetExecutionAdapterResult {
  if (target.domain !== "external_credential") throw new Error("unexpected fixture domain");
  const body = {
    adapterProtocol: target.adapterProtocol,
    domain: target.domain,
    operationIdSha256: target.operationIdSha256,
    targetReferenceSha256: target.targetReferenceSha256,
    outcome,
  };
  return {
    ...body,
    evidenceSha256: tenantCredentialTargetExecutionAdapterEvidenceSha256(body),
    replayed: false,
  };
}

async function seedTenant(store: MysqlSessionStore, tenantId: string): Promise<void> {
  await store.createSession(mkSession(tenantId, `user-${randomUUID()}`));
}

async function terminalInventory(
  store: MysqlSessionStore,
  tenantId: string,
  reference?: ProviderCredentialTargetReferenceWrite,
): Promise<string> {
  await seedTenant(store, tenantId);
  await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  await store.upsertProviderConfig(
    provider(tenantId),
    { ciphertext: Buffer.from("tenant-api-key-envelope"), keyId: "byok-key-v1" },
    null,
    reference,
  );
  return finishTenantCredentialRevocation(store, tenantId);
}

async function finishTenantCredentialRevocation(
  store: MysqlSessionStore,
  tenantId: string,
): Promise<string> {
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({
    requestId,
    tenantId,
    requestedByKeyId: "credential-target-execution-test",
    idempotencyKey: `credential-target-execution-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  });
  const claimToken = `t3a-${randomUUID()}`;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const claim = (await store.claimTenantCredentialRevocations({
      limit: 100,
      leaseMs: 60_000,
      claimToken,
    })).find((candidate) => candidate.requestId === requestId);
    if (claim) {
      await store.revokeTenantCredentialMaterial(revocationAuthorization(claim));
      return requestId;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("credential target execution T3a fixture was not claimable");
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant credential target execution", () => {
    let base: URL;
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";

    beforeAll(async () => {
      base = disposableBase(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    });

    beforeEach(async () => {
      database = `agent_service_credential_target_test_${process.pid}_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_credential_target_test_[A-Za-z0-9_]+$/.test(database)) {
        throw new Error("unsafe credential target execution database name");
      }
      await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(base, database);
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

    it("captures a trusted reference atomically and rolls back malformed or failed publication", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const malformedTenant = `tenant-malformed-${randomUUID()}`;
      const failedTenant = `tenant-failed-${randomUUID()}`;
      const capturedTenant = `tenant-captured-${randomUUID()}`;
      try {
        await seedTenant(store, malformedTenant);
        await seedTenant(store, failedTenant);
        await seedTenant(store, capturedTenant);
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });

        const malformed = protectedReference("malformed-management-id");
        malformed.targetReferenceCipherSha256 = "0".repeat(64);
        await expect(store.upsertProviderConfig(
          provider(malformedTenant),
          { ciphertext: Buffer.from("secret"), keyId: "byok-v1" },
          null,
          malformed,
        )).rejects.toThrow(/ciphertext hash mismatch/);

        await conn.query(
          `CREATE TRIGGER test_credential_target_capture_failure
             BEFORE INSERT ON tenant_credential_target_dispositions FOR EACH ROW
             SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected target publication failure'`,
        );
        await expect(store.upsertProviderConfig(
          provider(failedTenant),
          { ciphertext: Buffer.from("secret"), keyId: "byok-v1" },
          null,
          protectedReference("rollback-management-id"),
        )).rejects.toThrow(/injected target publication failure/);
        await conn.query("DROP TRIGGER test_credential_target_capture_failure");

        const reference = protectedReference("durable-management-id");
        await store.upsertProviderConfig(
          provider(capturedTenant),
          { ciphertext: Buffer.from("secret"), keyId: "byok-v1" },
          null,
          reference,
        );
        const [failedRows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM provider_configs WHERE tenant_id IN (?,?)) AS providers,
             (SELECT COUNT(*) FROM tenant_credential_provider_slots
               WHERE tenant_id IN (?,?)) AS slots,
             (SELECT COUNT(*) FROM tenant_credential_versions
               WHERE tenant_id IN (?,?)) AS versions,
             (SELECT COUNT(*) FROM tenant_credential_target_dispositions
               WHERE tenant_id IN (?,?)) AS targets`,
          [malformedTenant, failedTenant, malformedTenant, failedTenant,
            malformedTenant, failedTenant, malformedTenant, failedTenant],
        );
        expect(failedRows[0]).toMatchObject({ providers: 0, slots: 0, versions: 0, targets: 0 });
        const [capturedRows] = await conn.query<RowDataPacket[]>(
          `SELECT p.credential_version_id,d.disposition,d.adapter_protocol,
                  d.target_reference_cipher,d.target_reference_key_id,
                  d.target_reference_cipher_sha256,d.target_reference_sha256
             FROM provider_configs p
             JOIN tenant_credential_target_dispositions d
               ON d.tenant_id=p.tenant_id
              AND d.credential_version_id=p.credential_version_id
              AND d.domain='external_credential'
            WHERE p.tenant_id=? AND p.provider_id='managed-provider'`,
          [capturedTenant],
        );
        expect(capturedRows).toHaveLength(1);
        expect(capturedRows[0]).toMatchObject({
          disposition: "executable_ref",
          adapter_protocol: reference.adapterProtocol,
          target_reference_key_id: reference.targetReferenceKeyId,
          target_reference_cipher_sha256: reference.targetReferenceCipherSha256,
          target_reference_sha256: reference.targetReferenceSha256,
        });
        expect(Buffer.from(capturedRows[0]!.target_reference_cipher)).toEqual(
          reference.targetReferenceCipher,
        );
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("materializes once, elects one concurrent claimant, and isolates locator reads", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const competitor = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant-claim-${randomUUID()}`;
      const reference = protectedReference("claim-management-id");
      try {
        const requestId = await terminalInventory(store, tenantId, reference);
        expect(await store.materializeTenantCredentialTargetExecutionJobs({ limit: 10 })).toBe(1);
        expect(await store.materializeTenantCredentialTargetExecutionJobs({ limit: 10 })).toBe(0);
        const job = await store.getTenantCredentialTargetExecutionJob(tenantId, requestId);
        expect(job).toMatchObject({ phase: "queued", targetCount: 1 });
        expect(await store.getTenantCredentialTargetExecutionReference({
          requestId,
          tenantId,
          subjectGeneration: job!.subjectGeneration,
          targetExecutionGeneration: job!.targetExecutionGeneration,
          claimAttempt: 1,
          claimToken: "not-an-active-claim",
        }, 0)).toBeNull();

        const [left, right] = await Promise.all([
          store.claimTenantCredentialTargetExecutions({
            limit: 1,
            leaseMs: 60_000,
            claimToken: `left-${randomUUID()}`,
          }),
          competitor.claimTenantCredentialTargetExecutions({
            limit: 1,
            leaseMs: 60_000,
            claimToken: `right-${randomUUID()}`,
          }),
        ]);
        expect(left.length + right.length).toBe(1);
        const claim = (left[0] ?? right[0])!;
        const authorization = executionAuthorization(claim);
        const encrypted = await store.getTenantCredentialTargetExecutionReference(
          authorization,
          0,
        );
        expect(encrypted?.targetReferenceCipherSha256)
          .toBe(reference.targetReferenceCipherSha256);
        expect(Buffer.from(encrypted!.targetReferenceCipher)).toEqual(
          reference.targetReferenceCipher,
        );
        expect(await store.getTenantCredentialTargetExecutionReference({
          ...authorization,
          tenantId: `neighbor-${randomUUID()}`,
        }, 0)).toBeNull();
        expect(await store.getTenantCredentialTargetExecutionJob(
          `neighbor-${randomUUID()}`,
          requestId,
        )).toBeNull();
      } finally {
        await competitor.close();
        await store.close();
      }
    });

    it("atomically materializes versions whose source dispositions have different capture times", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-multiple-capture-times-${randomUUID()}`;
      try {
        await seedTenant(store, tenantId);
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
        await store.upsertProviderConfig(
          provider(tenantId, "managed-provider-a"),
          { ciphertext: Buffer.from("tenant-api-key-envelope-a"), keyId: "byok-key-v1" },
          null,
          protectedReference("management-id-a"),
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        await store.upsertProviderConfig(
          provider(tenantId, "managed-provider-b"),
          { ciphertext: Buffer.from("tenant-api-key-envelope-b"), keyId: "byok-key-v1" },
          null,
          protectedReference("management-id-b"),
        );
        const [sourceRows] = await conn.query<RowDataPacket[]>(
          `SELECT captured_at_db_ms
             FROM tenant_credential_target_dispositions
            WHERE tenant_id=? AND domain='external_credential'
              AND disposition='executable_ref'`,
          [tenantId],
        );
        expect(sourceRows).toHaveLength(2);
        expect(new Set(sourceRows.map((row) => Number(row.captured_at_db_ms))).size).toBe(2);
        const requestId = await finishTenantCredentialRevocation(store, tenantId);

        expect(await store.materializeTenantCredentialTargetExecutionJobs({ limit: 10 })).toBe(1);
        const targets = await store.getTenantCredentialTargetExecutionTargets(
          tenantId,
          requestId,
          1,
        );
        expect(targets).toHaveLength(2);
        expect(new Set(targets.map((target) => target.capturedAtDbMs)).size).toBe(1);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back the job and first target when the second target publication fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-target-publication-rollback-${randomUUID()}`;
      try {
        await seedTenant(store, tenantId);
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
        await store.upsertProviderConfig(
          provider(tenantId, "managed-provider-a"),
          { ciphertext: Buffer.from("tenant-api-key-envelope-a"), keyId: "byok-key-v1" },
          null,
          protectedReference("rollback-management-id-a"),
        );
        await store.upsertProviderConfig(
          provider(tenantId, "managed-provider-b"),
          { ciphertext: Buffer.from("tenant-api-key-envelope-b"), keyId: "byok-key-v1" },
          null,
          protectedReference("rollback-management-id-b"),
        );
        const requestId = await finishTenantCredentialRevocation(store, tenantId);
        await conn.query(
          `CREATE TRIGGER test_credential_target_second_insert_failure
             BEFORE INSERT ON tenant_credential_target_execution_targets FOR EACH ROW
             BEGIN IF NEW.target_ordinal=1 THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected second target failure';
             END IF; END`,
        );

        await expect(store.materializeTenantCredentialTargetExecutionJobs({ limit: 10 }))
          .rejects.toThrow(/injected second target failure/);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_credential_target_execution_jobs
               WHERE request_id=?) AS jobs,
             (SELECT COUNT(*) FROM tenant_credential_target_execution_targets
               WHERE request_id=?) AS targets`,
          [requestId, requestId],
        );
        expect(rows[0]).toMatchObject({ jobs: 0, targets: 0 });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back an ACK when publishing its job projection fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-ack-publication-rollback-${randomUUID()}`;
      try {
        const requestId = await terminalInventory(
          store,
          tenantId,
          protectedReference("ack-rollback-management-id"),
        );
        await store.materializeTenantCredentialTargetExecutionJobs({ limit: 1 });
        const claim = (await store.claimTenantCredentialTargetExecutions({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `ack-rollback-${randomUUID()}`,
        }))[0]!;
        const target = (await store.getTenantCredentialTargetExecutionTargets(
          tenantId,
          requestId,
          claim.targetExecutionGeneration,
        ))[0]!;
        await conn.query(
          `CREATE TRIGGER test_credential_target_ack_projection_failure
             BEFORE UPDATE ON tenant_credential_target_execution_jobs FOR EACH ROW
             BEGIN IF NEW.target_ack_count>OLD.target_ack_count THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected ACK projection failure';
             END IF; END`,
        );

        await expect(store.recordTenantCredentialTargetExecutionTargetAck(
          executionAuthorization(claim),
          adapterResult(target),
        )).rejects.toThrow(/injected ACK projection failure/);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT j.target_ack_count,
                  (SELECT COUNT(*) FROM tenant_credential_target_execution_acks a
                    WHERE a.request_id=j.request_id) AS ack_rows
             FROM tenant_credential_target_execution_jobs j
            WHERE j.request_id=? AND j.tenant_id=?`,
          [requestId, tenantId],
        );
        expect(rows[0]).toMatchObject({ target_ack_count: 0, ack_rows: 0 });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("fences stale leases, replays exact ACKs, rejects conflicts, and seals atomically", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-seal-${randomUUID()}`;
      try {
        const requestId = await terminalInventory(
          store,
          tenantId,
          protectedReference("seal-management-id"),
        );
        await store.materializeTenantCredentialTargetExecutionJobs({ limit: 1 });
        const first = (await store.claimTenantCredentialTargetExecutions({
          limit: 1,
          leaseMs: 1,
          claimToken: `first-${randomUUID()}`,
        }))[0]!;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        const second = (await store.claimTenantCredentialTargetExecutions({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `second-${randomUUID()}`,
        }))[0]!;
        const target = (await store.getTenantCredentialTargetExecutionTargets(
          tenantId,
          requestId,
          second.targetExecutionGeneration,
        ))[0]!;
        const result = adapterResult(target);
        const activeJob = await store.getTenantCredentialTargetExecutionJob(
          tenantId,
          requestId,
        );
        if (!activeJob || activeJob.phase !== "queued") throw new Error("expected active job");
        expect(await store.getTenantCredentialTargetExecutionReference(
          executionAuthorization(first),
          0,
        )).toBeNull();
        expect(await store.recordTenantCredentialTargetExecutionTargetAck(
          executionAuthorization(first),
          result,
        )).toBeNull();
        const clockControlledStore = store as unknown as {
          databaseNow: (...args: unknown[]) => Promise<number>;
        };
        const databaseNow = clockControlledStore.databaseNow.bind(store);
        clockControlledStore.databaseNow = async () => Math.min(
          activeJob.sourceEvidenceDbMs,
          activeJob.createdAtMs,
          target.capturedAtDbMs,
        ) - 1;
        try {
          await expect(store.recordTenantCredentialTargetExecutionTargetAck(
            executionAuthorization(second),
            result,
          )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        } finally {
          clockControlledStore.databaseNow = databaseNow;
        }
        const [preAckRows] = await conn.query<RowDataPacket[]>(
          `SELECT j.target_ack_count,
                  (SELECT COUNT(*) FROM tenant_credential_target_execution_acks a
                    WHERE a.request_id=j.request_id) AS ack_rows
             FROM tenant_credential_target_execution_jobs j
            WHERE j.request_id=? AND j.tenant_id=?`,
          [requestId, tenantId],
        );
        expect(preAckRows[0]).toMatchObject({ target_ack_count: 0, ack_rows: 0 });
        const ack = await store.recordTenantCredentialTargetExecutionTargetAck(
          executionAuthorization(second),
          result,
        );
        expect(ack).toMatchObject({ targetOrdinal: 0, outcome: "revoked" });
        if (!ack) throw new Error("expected target ACK");
        expect(await store.recordTenantCredentialTargetExecutionTargetAck(
          { ...executionAuthorization(second), claimToken: `foreign-${randomUUID()}` },
          result,
        )).toBeNull();
        expect(await store.recordTenantCredentialTargetExecutionTargetAck(
          executionAuthorization(second),
          result,
        )).toEqual(ack);
        expect(await store.recordTenantCredentialTargetExecutionTargetAck(
          {
            ...executionAuthorization(second),
            subjectGeneration: second.subjectGeneration + 1,
          },
          result,
        )).toBeNull();
        expect(await store.recordTenantCredentialTargetExecutionTargetAck(
          {
            ...executionAuthorization(second),
            targetExecutionGeneration: second.targetExecutionGeneration + 1,
          },
          result,
        )).toBeNull();
        await expect(store.recordTenantCredentialTargetExecutionTargetAck(
          executionAuthorization(second),
          adapterResult(target, "already_absent"),
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await conn.query(
          `UPDATE tenant_credential_target_execution_jobs
              SET lease_until_ms=updated_at_ms
            WHERE request_id=? AND tenant_id=?`,
          [requestId, tenantId],
        );
        expect(await store.recordTenantCredentialTargetExecutionTargetAck(
          executionAuthorization(second),
          result,
        )).toEqual(ack);
        const third = (await store.claimTenantCredentialTargetExecutions({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `third-${randomUUID()}`,
        }))[0]!;

        clockControlledStore.databaseNow = async () => ack.storeDbTimestampMs - 1;
        try {
          await expect(store.sealTenantCredentialTargetExecution(
            executionAuthorization(third),
          )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        } finally {
          clockControlledStore.databaseNow = databaseNow;
        }
        expect(await store.getTenantCredentialTargetExecutionReceipt(tenantId, requestId))
          .toBeNull();
        expect(await store.getTenantCredentialTargetExecutionCutover())
          .toEqual({ singletonId: 1, controlGeneration: 0 });
        expect(await store.getTenantCredentialTargetExecutionJob(tenantId, requestId))
          .toMatchObject({ phase: "queued", targetAckCount: 1 });

        await conn.query(
          `CREATE TRIGGER test_credential_target_seal_failure
             BEFORE UPDATE ON tenant_credential_target_execution_jobs FOR EACH ROW
             BEGIN IF NEW.phase='external_credential_sealed' THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected seal failure';
             END IF; END`,
        );
        await expect(store.sealTenantCredentialTargetExecution(
          executionAuthorization(third),
        )).rejects.toThrow(/injected seal failure/);
        expect(await store.getTenantCredentialTargetExecutionReceipt(tenantId, requestId))
          .toBeNull();
        expect(await store.getTenantCredentialTargetExecutionCutover())
          .toEqual({ singletonId: 1, controlGeneration: 0 });
        expect(await store.getTenantCredentialTargetExecutionJob(tenantId, requestId))
          .toMatchObject({ phase: "queued", targetAckCount: 1 });
        await conn.query("DROP TRIGGER test_credential_target_seal_failure");

        const receipt = await store.sealTenantCredentialTargetExecution(
          executionAuthorization(third),
        );
        expect(receipt).toMatchObject({
          externalCredentialExecutionComplete: true,
          kmsKeyExecutionComplete: false,
          allDomainsComplete: false,
          contentPurgeExecuted: false,
          targetCount: 1,
          targetAckCount: 1,
          unresolvedBlockerCount: 1,
        });
        expect(await store.getTenantCredentialTargetExecutionCutover()).toMatchObject({
          controlGeneration: 1,
          firstRequestId: requestId,
          firstReceiptSha256: receipt!.receiptSha256,
          externalCredentialExecutionEnabled: true,
          kmsKeyExecutionEnabled: false,
        });
        expect(await store.sealTenantCredentialTargetExecution(
          executionAuthorization(third),
        )).toEqual(receipt);
        expect(await store.sealTenantCredentialTargetExecution({
          ...executionAuthorization(third),
          subjectGeneration: third.subjectGeneration + 1,
        })).toBeNull();
        expect(await store.sealTenantCredentialTargetExecution({
          ...executionAuthorization(third),
          targetExecutionGeneration: third.targetExecutionGeneration + 1,
        })).toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("materializes a source blocker as terminal without exposing a locator", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant-blocked-${randomUUID()}`;
      try {
        const requestId = await terminalInventory(store, tenantId);
        expect(await store.materializeTenantCredentialTargetExecutionJobs({ limit: 1 })).toBe(1);
        expect(await store.getTenantCredentialTargetExecutionJob(tenantId, requestId))
          .toMatchObject({
            phase: "blocked",
            blockedReasonCode: "source_blocked",
            externalCredentialBlockerCount: 1,
          });
        expect(await store.claimTenantCredentialTargetExecutions({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `blocked-${randomUUID()}`,
        })).toEqual([]);
        expect(await store.getTenantCredentialTargetExecutionTargets(tenantId, requestId, 1))
          .toEqual([]);
      } finally {
        await store.close();
      }
    });

    it("fails closed and rolls back materialization when immutable source bytes drift", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-drift-${randomUUID()}`;
      try {
        const requestId = await terminalInventory(
          store,
          tenantId,
          protectedReference("drift-management-id"),
        );
        for (const trigger of [
          "trg_credential_targets_bu_bootstrap",
          "trg_credential_targets_bu",
          "trg_credential_targets_bu_guard_a",
        ]) {
          await conn.query(`DROP TRIGGER ${trigger}`);
        }
        await conn.query(
          `UPDATE tenant_credential_target_dispositions
              SET target_reference_cipher=CONCAT(target_reference_cipher, X'00')
            WHERE tenant_id=? AND domain='external_credential'`,
          [tenantId],
        );
        await expect(store.materializeTenantCredentialTargetExecutionJobs({ limit: 1 }))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [rows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS count FROM tenant_credential_target_execution_jobs WHERE request_id=?",
          [requestId],
        );
        expect(Number(rows[0]!.count)).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects terminal blocking when the immutable target projection has drifted", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-block-drift-${randomUUID()}`;
      try {
        const requestId = await terminalInventory(
          store,
          tenantId,
          protectedReference("block-drift-management-id"),
        );
        await store.materializeTenantCredentialTargetExecutionJobs({ limit: 1 });
        const claim = (await store.claimTenantCredentialTargetExecutions({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `block-drift-${randomUUID()}`,
        }))[0]!;
        await conn.query("DROP TRIGGER trg_target_exec_targets_bu");
        await conn.query(
          `UPDATE tenant_credential_target_execution_targets
              SET adapter_protocol='tampered-adapter-v1'
            WHERE request_id=? AND target_ordinal=0`,
          [requestId],
        );

        await expect(store.blockTenantCredentialTargetExecution(
          executionAuthorization(claim),
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT phase, claim_token
             FROM tenant_credential_target_execution_jobs
            WHERE request_id=? AND tenant_id=?`,
          [requestId, tenantId],
        );
        expect(rows[0]).toMatchObject({ phase: "queued", claim_token: claim.claimToken });
      } finally {
        await conn.end();
        await store.close();
      }
    });
  });
}
