import { createHash, randomUUID } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MysqlSessionStore,
  SubjectDeletingError,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TenantTelemetryWriteConflictError,
  newErasureRequestId,
  tenantErasureRequestHash,
  tenantTelemetryArtifactMembershipSha256,
  tenantTelemetryWriteAdapterEvidenceSha256,
  type EnqueueTenantTelemetryArtifactInput,
  type TenantTelemetryWriteAdapterResult,
  type TenantTelemetryWriteAuthorization,
  type TenantTelemetryWriteClaim,
} from "../src/index.js";
import { mkSession } from "./conformance.js";
import {
  statefulTelemetryEnqueueCaptureFixture,
  trustedRunnerTelemetryRecord,
} from "./tenant-telemetry-adapter.fixture.js";

const BASE_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const REF_KEY = Buffer.alloc(32, 0x45);
type Row = RowDataPacket;

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

function databaseName(): string {
  return `agent_service_telemetry_writer_test_${process.pid}_${randomUUID()
    .replaceAll("-", "").slice(0, 8)}`;
}

async function waitForBlockedQuery(
  observer: Connection,
  fragments: string[],
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<Row[]>("SHOW FULL PROCESSLIST");
    if (rows.some((row) => {
      const stateAndInfo = `${String(row.State ?? row.state ?? "")} ${String(
        row.Info ?? row.info ?? "",
      )}`;
      return fragments.every((fragment) => stateAndInfo.includes(fragment));
    })) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for blocked MySQL query: ${fragments.join(" / ")}`);
}

async function waitForSubjectLifecycleLockWaiter(
  observer: Connection,
  database: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<(Row & { waiters: number })[]>(
      `SELECT COUNT(DISTINCT waits.REQUESTING_ENGINE_TRANSACTION_ID) AS waiters
         FROM performance_schema.data_lock_waits waits
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA=? AND requested.OBJECT_NAME='subject_lifecycle'`,
      [database],
    );
    if (Number(rows[0]?.waiters ?? 0) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for tenant lifecycle gate lock waiter");
}

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

const activation = () => ({
  expectedControlGeneration: 0 as const,
  targets: [
    {
      domain: "logs" as const,
      backendKind: "test_sink",
      adapterProtocol: "telemetry-test-v1",
      namespaceSha256: digest("writer:logs:namespace"),
      failureDomainSha256: digest("writer:logs:failure-domain"),
    },
    {
      domain: "traces" as const,
      backendKind: "test_sink",
      adapterProtocol: "telemetry-test-v1",
      namespaceSha256: digest("writer:traces:namespace"),
      failureDomainSha256: digest("writer:traces:failure-domain"),
    },
  ],
});

function input(
  tenantId: string,
  marker: string,
  overrides: Partial<EnqueueTenantTelemetryArtifactInput> = {},
): EnqueueTenantTelemetryArtifactInput {
  const ownerKind = overrides.ownerKind ?? "tenant";
  const ownerId = overrides.ownerId ?? tenantId;
  return {
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256: digest(`${marker}:artifact`),
    artifactGeneration: 1,
    ownerKind,
    ownerId,
    ownerUserId: null,
    sourceSchema: "structured-log-batch-v1",
    sourceGeneration: 0,
    sourceHighWaterDbMs: Date.now(),
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs",
      records: [trustedRunnerTelemetryRecord(Date.now(), {
        opaqueRefKey: REF_KEY,
        tenantValue: tenantId,
        ownerKind,
        ownerValue: ownerId,
        attempt: 1,
      })],
    },
    ...overrides,
  };
}

function authorization(claim: TenantTelemetryWriteClaim): TenantTelemetryWriteAuthorization {
  return {
    writeOperationSha256: claim.writeOperationSha256,
    tenantId: claim.tenantId,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function adapterResult(claim: TenantTelemetryWriteClaim): TenantTelemetryWriteAdapterResult {
  const evidence = {
    adapterProtocol: claim.target.adapterProtocol,
    domain: claim.inventory.domain,
    targetSha256: claim.target.targetSha256,
    writeOperationSha256: claim.writeOperationSha256,
    artifactIdSha256: claim.inventory.artifactIdSha256,
    artifactGeneration: claim.inventory.artifactGeneration,
    payloadSha256: claim.inventory.payloadSha256,
    manifestSha256: claim.inventory.manifestSha256,
    outcome: "written" as const,
    replayed: false,
  };
  return {
    ...evidence,
    evidenceSha256: tenantTelemetryWriteAdapterEvidenceSha256(evidence),
  };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore durable tenant telemetry writer", () => {
    it("rejects a syntax-valid literal record at live enqueue capture", async () => {
      const ctx = await fixture();
      try {
        const tenantId = "mysql-writer-untrusted";
        await ctx.store.createApiKey(tenantId, "key", digest("untrusted-key"));
        const writeInput = input(tenantId, "untrusted");
        writeInput.payload = structuredClone(writeInput.payload);
        await expect(ctx.store.enqueueTenantTelemetryArtifact(writeInput))
          .rejects.toThrow(/not produced by createStructuredTelemetry/);
        const [rows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_write_jobs) AS jobs,
             (SELECT COUNT(*) FROM tenant_telemetry_write_payloads) AS payloads`,
        );
        expect(rows[0]).toMatchObject({ jobs: 0, payloads: 0 });
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("rejects trusted records bound to another producer key or lifecycle owner", async () => {
      const ctx = await fixture();
      try {
        const tenantId = "mysql-writer-owner-binding";
        await ctx.store.createApiKey(tenantId, "key", digest("owner-binding-key"));

        const wrongKey = input(tenantId, "wrong-producer-key");
        wrongKey.payload = {
          ...wrongKey.payload,
          records: [trustedRunnerTelemetryRecord(Date.now(), {
            opaqueRefKey: Buffer.alloc(32, 0x7f),
            ownerKind: "tenant",
            ownerValue: tenantId,
          })],
        };
        await expect(ctx.store.enqueueTenantTelemetryArtifact(wrongKey))
          .rejects.toThrow(/producer key/);

        const wrongOwner = input(tenantId, "wrong-owner");
        wrongOwner.payload = {
          ...wrongOwner.payload,
          records: [trustedRunnerTelemetryRecord(Date.now(), {
            opaqueRefKey: REF_KEY,
            ownerKind: "tenant",
            ownerValue: "mysql-writer-other-tenant",
          })],
        };
        await expect(ctx.store.enqueueTenantTelemetryArtifact(wrongOwner))
          .rejects.toThrow(/tenant binding/);

        const crossOwner = input(tenantId, "cross-owner");
        crossOwner.payload = {
          ...crossOwner.payload,
          records: [trustedRunnerTelemetryRecord(Date.now(), {
            opaqueRefKey: REF_KEY,
            ownerKind: "tenant",
            ownerValue: tenantId,
            subjectKind: "tenant",
            subjectValue: "mysql-writer-other-tenant",
          })],
        };
        await expect(ctx.store.enqueueTenantTelemetryArtifact(crossOwner))
          .rejects.toThrow(/cross-owner lifecycle reference/);
        const [rows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_write_jobs) AS jobs,
             (SELECT COUNT(*) FROM tenant_telemetry_write_payloads) AS payloads`,
        );
        expect(rows[0]).toMatchObject({ jobs: 0, payloads: 0 });
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("binds the principal tenant alongside shared user and session owner references", async () => {
      const ctx = await fixture();
      try {
        const tenantA = "mysql-writer-principal-a";
        const tenantB = "mysql-writer-principal-b";
        const sharedUserId = "mysql-writer-shared-user";
        const sessionA = mkSession(tenantA, sharedUserId);
        const sessionB = mkSession(tenantB, sharedUserId);
        await ctx.store.createSession(sessionA);
        await ctx.store.createSession(sessionB);

        await expect(ctx.store.enqueueTenantTelemetryArtifact(input(tenantA, "principal-user-a", {
          ownerKind: "user",
          ownerId: sharedUserId,
          ownerUserId: sharedUserId,
        }))).resolves.toMatchObject({ tenantId: tenantA, phase: "queued" });

        const crossTenantUser = input(tenantB, "principal-user-b", {
          ownerKind: "user",
          ownerId: sharedUserId,
          ownerUserId: sharedUserId,
        });
        crossTenantUser.payload = {
          ...crossTenantUser.payload,
          records: [trustedRunnerTelemetryRecord(Date.now(), {
            opaqueRefKey: REF_KEY,
            tenantValue: tenantA,
            ownerKind: "user",
            ownerValue: sharedUserId,
          })],
        };
        await expect(ctx.store.enqueueTenantTelemetryArtifact(crossTenantUser))
          .rejects.toThrow(/tenant binding/);

        await expect(ctx.store.enqueueTenantTelemetryArtifact(input(tenantA, "principal-session", {
          ownerKind: "session",
          ownerId: sessionA.id,
          ownerUserId: sharedUserId,
        }))).resolves.toMatchObject({ tenantId: tenantA, phase: "queued" });

        const wrongSession = input(tenantA, "principal-wrong-session", {
          ownerKind: "session",
          ownerId: sessionA.id,
          ownerUserId: sharedUserId,
        });
        wrongSession.payload = {
          ...wrongSession.payload,
          records: [trustedRunnerTelemetryRecord(Date.now(), {
            opaqueRefKey: REF_KEY,
            tenantValue: tenantA,
            ownerKind: "session",
            ownerValue: sessionB.id,
          })],
        };
        await expect(ctx.store.enqueueTenantTelemetryArtifact(wrongSession))
          .rejects.toThrow(/owner binding/);
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("captures stateful enqueue getters once and cannot swap in a literal record", async () => {
      const ctx = await fixture();
      try {
        const tenantId = "mysql-writer-stateful-capture";
        await ctx.store.createApiKey(tenantId, "key", digest("stateful-capture-key"));
        const capture = statefulTelemetryEnqueueCaptureFixture(
          input(tenantId, "stateful-capture"),
        );

        const queued = await ctx.store.enqueueTenantTelemetryArtifact(capture.input);
        expect([...capture.topLevelReads.values()]).toEqual(Array(12).fill(1));
        expect(Object.fromEntries(capture.payloadReads)).toEqual({
          schema: 1,
          domain: 1,
          records: 1,
        });
        expect(Object.fromEntries(capture.recordArrayReads)).toEqual({ length: 1, 0: 1 });

        const [claim] = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 1,
          leaseMs: 1_000,
          claimToken: "mysql-writer-stateful-capture-claim",
          adapterProtocol: "telemetry-test-v1",
        });
        expect(claim?.writeOperationSha256).toBe(queued.writeOperationSha256);
        expect(claim?.payload.records[0]?.fields.attempt).toBe(1);
        expect(claim?.payload.records[0]?.fields.attempt)
          .not.toBe(capture.injectedLiteralAttempt);
      } finally {
        await ctx.close();
      }
    }, 45_000);

    let admin: Connection;
    let base: URL;

    beforeAll(async () => {
      base = disposableBase(BASE_URL);
      const adminUrl = new URL(base);
      adminUrl.pathname = "/mysql";
      admin = await mysql.createConnection(adminUrl.toString());
    });

    afterAll(async () => {
      await admin?.end();
    });

    async function fixture(
      activationInput = activation(),
    ): Promise<{
      database: string;
      url: string;
      store: MysqlSessionStore;
      conn: Connection;
      close(): Promise<void>;
    }> {
      const database = databaseName();
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      const url = databaseUrl(base, database);
      const store = await MysqlSessionStore.connect({
        url,
        connectionLimit: 12,
        tenantTelemetryRefKey: REF_KEY,
      });
      await store.activateTenantTelemetryLifecycle(activationInput);
      const conn = await mysql.createConnection(url);
      return {
        database,
        url,
        store,
        conn,
        async close() {
          await conn.end();
          await store.close();
          await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        },
      };
    }

    it("atomically enqueues, claims and seals inventory plus ACK with exact replay", async () => {
      const ctx = await fixture();
      try {
        const session = mkSession("mysql-writer-success", "mysql-writer-user");
        await ctx.store.createSession(session);
        const writeInput = input(session.tenantId, "success", {
          ownerKind: "session",
          ownerId: session.id,
          ownerUserId: session.userId,
        });

        const [left, right] = await Promise.all([
          ctx.store.enqueueTenantTelemetryArtifact(writeInput),
          ctx.store.enqueueTenantTelemetryArtifact(writeInput),
        ]);
        expect(right).toEqual(left);
        expect(left).toMatchObject({ phase: "queued", attempts: 0, recordCount: 1 });
        const membership = await ctx.store.getTenantTelemetryArtifactMembership(
          session.tenantId,
          left.writeOperationSha256,
        );
        expect(membership).toMatchObject({
          writeOperationSha256: left.writeOperationSha256,
          inventorySha256: left.inventory.inventorySha256,
          ownerKind: "session",
          lifecycleCoverageEvidenceSha256: left.inventory.coverageEvidenceSha256,
          lifecycleHistoryStatus: left.inventory.historyStatus,
          applicationBindingReceiptSha256: null,
        });
        expect(JSON.stringify(membership)).not.toContain(session.id);
        expect(JSON.stringify(membership)).not.toContain(session.userId);
        await expect(ctx.store.getTenantTelemetryArtifactMembership(
          "other-tenant", left.writeOperationSha256,
        )).resolves.toBeNull();
        expect(JSON.stringify(left)).not.toContain(session.id);
        expect(JSON.stringify(left)).not.toContain(session.userId);
        const [storedPayload] = await ctx.conn.query<Row[]>(
          `SELECT CAST(payload_json AS CHAR) AS payload_json
             FROM tenant_telemetry_write_payloads WHERE write_operation_sha256=?`,
          [left.writeOperationSha256],
        );
        expect(String(storedPayload[0]?.payload_json)).not.toContain(session.id);
        expect(String(storedPayload[0]?.payload_json)).not.toContain(session.userId);

        const concurrentClaims = await Promise.all([
          ctx.store.claimTenantTelemetryWriteJobs({
            limit: 1,
            leaseMs: 60_000,
            claimToken: "mysql-writer-claim-a",
            adapterProtocol: "telemetry-test-v1",
          }),
          ctx.store.claimTenantTelemetryWriteJobs({
            limit: 1,
            leaseMs: 60_000,
            claimToken: "mysql-writer-claim-b",
            adapterProtocol: "telemetry-test-v1",
          }),
        ]);
        expect(concurrentClaims.flat()).toHaveLength(1);
        const claim = concurrentClaims.flat()[0]!;
        const auth = authorization(claim);
        await expect(ctx.store.completeTenantTelemetryWrite(auth, adapterResult(claim)))
          .rejects.toBeInstanceOf(TenantTelemetryWriteConflictError);
        await ctx.store.reserveTenantTelemetryExternalMutation(
          auth, claim.target.adapterProtocol,
        );
        const result = adapterResult(claim);
        const ack = await ctx.store.completeTenantTelemetryWrite(auth, result);
        expect(ack).toMatchObject({
          tenantId: session.tenantId,
          writeOperationSha256: left.writeOperationSha256,
          outcome: "written",
        });
        await expect(ctx.store.completeTenantTelemetryWrite(auth, result)).resolves.toEqual(ack);
        await expect(ctx.store.completeTenantTelemetryWrite({
          ...auth,
          claimToken: "mysql-writer-stale-token",
        }, result)).resolves.toBeNull();
        await expect(ctx.store.getTenantTelemetryArtifact(
          session.tenantId,
          writeInput.domain,
          writeInput.artifactIdSha256,
          writeInput.artifactGeneration,
        )).resolves.toMatchObject({ receiptSha256: ack!.inventoryReceiptSha256 });
        await expect(ctx.store.getTenantTelemetryWriteJob(
          "other-tenant",
          left.writeOperationSha256,
        )).resolves.toBeNull();
        await expect(ctx.store.getTenantTelemetryWriteAck(
          "other-tenant",
          left.writeOperationSha256,
        )).resolves.toBeNull();
        const [projection] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_write_payloads
               WHERE write_operation_sha256=?) AS payloads,
             (SELECT COUNT(*) FROM tenant_telemetry_write_acks
               WHERE write_operation_sha256=?) AS acks,
             (SELECT COUNT(*) FROM tenant_telemetry_artifact_inventory
               WHERE inventory_sha256=?) AS inventories,
             (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships
               WHERE write_operation_sha256=?) AS memberships`,
          [left.writeOperationSha256, left.writeOperationSha256,
            left.inventory.inventorySha256, left.writeOperationSha256],
        );
        expect(Number(projection[0]?.payloads)).toBe(0);
        expect(Number(projection[0]?.acks)).toBe(1);
        expect(Number(projection[0]?.inventories)).toBe(1);
        expect(Number(projection[0]?.memberships)).toBe(1);
        await expect(ctx.store.getTenantTelemetryArtifactMembership(
          session.tenantId, left.writeOperationSha256,
        )).resolves.toEqual(membership);
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("publishes no partial spool on capture or payload insert failure", async () => {
      const ctx = await fixture();
      try {
        await ctx.store.createApiKey("mysql-writer-enqueue-rollback", "key", digest("key"));
        const invalid = input("mysql-writer-enqueue-rollback", "capture");
        Object.defineProperty(invalid, "payload", {
          enumerable: true,
          get() { throw new Error("injected telemetry capture failure"); },
        });
        await expect(ctx.store.enqueueTenantTelemetryArtifact(invalid))
          .rejects.toThrow("injected telemetry capture failure");

        const triggerName = `test_writer_payload_rollback_${randomUUID()
          .replaceAll("-", "").slice(0, 8)}`;
        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT
             ON tenant_telemetry_write_payloads FOR EACH ROW
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected telemetry payload failure'`,
        );
        try {
          await expect(ctx.store.enqueueTenantTelemetryArtifact(
            input("mysql-writer-enqueue-rollback", "sql-rollback"),
          )).rejects.toThrow("injected telemetry payload failure");
        } finally {
          await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
        }
        const [counts] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_write_jobs) AS jobs,
             (SELECT COUNT(*) FROM tenant_telemetry_write_payloads) AS payloads,
             (SELECT COUNT(*) FROM tenant_telemetry_write_acks) AS acks,
             (SELECT COUNT(*) FROM tenant_telemetry_artifact_inventory) AS inventories,
             (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships) AS memberships`,
        );
        expect(counts[0]).toMatchObject({
          jobs: 0, payloads: 0, acks: 0, inventories: 0, memberships: 0,
        });
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("rejects a direct cross-tenant sidecar and fails closed on an orphan footprint", async () => {
      const ctx = await fixture();
      try {
        const tenantId = "mysql-writer-membership-footprint";
        await ctx.store.createApiKey(tenantId, "key", digest("membership-footprint-key"));
        const job = await ctx.store.enqueueTenantTelemetryArtifact(
          input(tenantId, "membership-footprint"),
        );
        const source = await ctx.store.getTenantTelemetryArtifactMembership(
          tenantId, job.writeOperationSha256,
        );
        expect(source).not.toBeNull();
        const { membershipSha256: _sourceReceipt, ...body } = source!;
        const insert = async (replacementTenantId: string, marker: string): Promise<string> => {
          const changed = {
            ...body,
            tenantId: replacementTenantId,
            writeOperationSha256: digest(`membership-footprint:${marker}:operation`),
            inventorySha256: digest(`membership-footprint:${marker}:inventory`),
          };
          await ctx.conn.query(
            `INSERT INTO tenant_telemetry_artifact_memberships
               (write_operation_sha256,membership_sha256,tenant_id,scope,domain,
                target_sha256,inventory_sha256,artifact_id_sha256,artifact_generation,
                manifest_sha256,payload_sha256,owner_kind,tenant_ref_sha256,
                owner_ref_sha256,hold_subject_ref_sha256,ref_key_id_sha256,
                owner_binding_sha256,lifecycle_coverage_evidence_sha256,
                lifecycle_history_status,application_binding_receipt_sha256,
                source_schema,source_generation,source_high_water_db_ms,
                inventory_created_at_db_ms)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [changed.writeOperationSha256, tenantTelemetryArtifactMembershipSha256(changed),
              changed.tenantId, changed.scope, changed.domain, changed.targetSha256,
              changed.inventorySha256, changed.artifactIdSha256, changed.artifactGeneration,
              changed.manifestSha256, changed.payloadSha256, changed.ownerKind,
              changed.tenantRefSha256, changed.ownerRefSha256,
              changed.holdSubjectRefSha256, changed.refKeyIdSha256,
              changed.ownerBindingSha256, changed.lifecycleCoverageEvidenceSha256,
              changed.lifecycleHistoryStatus, changed.applicationBindingReceiptSha256,
              changed.sourceSchema, changed.sourceGeneration, changed.sourceHighWaterDbMs,
              changed.inventoryCreatedAtDbMs],
          );
          return changed.writeOperationSha256;
        };
        await expect(insert("mysql-writer-foreign-tenant", "foreign"))
          .rejects.toThrow(/membership is not exact active-source-bound/);
        const orphanOperation = await insert(tenantId, "orphan");
        await expect(ctx.store.getTenantTelemetryArtifactMembership(
          tenantId, orphanOperation,
        )).rejects.toThrow(/orphaned/);
        await expect(MysqlSessionStore.connect({
          url: ctx.url,
          tenantTelemetryRefKey: REF_KEY,
        })).rejects.toThrow(/orphan|membership/i);
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("atomically filters claims by adapter protocol without blocking another adapter", async () => {
      const targetActivation = activation();
      targetActivation.targets[1] = {
        ...targetActivation.targets[1]!,
        adapterProtocol: "telemetry-other-v1",
      };
      const ctx = await fixture(targetActivation);
      try {
        const tenantId = "mysql-writer-mixed-adapter";
        await ctx.store.createApiKey(tenantId, "key", digest("mixed-adapter-key"));
        await ctx.store.enqueueTenantTelemetryArtifact(input(tenantId, "mixed-logs"));
        const traceInput = input(tenantId, "mixed-traces", { domain: "traces" });
        traceInput.payload = { ...traceInput.payload, domain: "traces" };
        await ctx.store.enqueueTenantTelemetryArtifact(traceInput);

        const wrong = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 10,
          leaseMs: 60_000,
          claimToken: "mysql-writer-mixed-wrong",
          adapterProtocol: "telemetry-unknown-v1",
        });
        expect(wrong).toHaveLength(0);
        const logs = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 10,
          leaseMs: 60_000,
          claimToken: "mysql-writer-mixed-logs",
          adapterProtocol: "telemetry-test-v1",
        });
        expect(logs).toHaveLength(1);
        expect(logs[0]!.inventory.domain).toBe("logs");
        const traces = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 10,
          leaseMs: 60_000,
          claimToken: "mysql-writer-mixed-traces",
          adapterProtocol: "telemetry-other-v1",
        });
        expect(traces).toHaveLength(1);
        expect(traces[0]!.inventory.domain).toBe("traces");
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("rolls back inventory, ACK, terminal job and payload deletion as one transaction", async () => {
      const ctx = await fixture();
      try {
        const tenantId = "mysql-writer-complete-rollback";
        await ctx.store.createApiKey(tenantId, "key", digest("complete-key"));
        const writeInput = input(tenantId, "complete-rollback");
        const queued = await ctx.store.enqueueTenantTelemetryArtifact(writeInput);
        const [claim] = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "mysql-writer-complete-rollback",
          adapterProtocol: "telemetry-test-v1",
        });
        const triggerName = `test_writer_ack_rollback_${randomUUID()
          .replaceAll("-", "").slice(0, 8)}`;
        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT
             ON tenant_telemetry_write_acks FOR EACH ROW
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected telemetry ACK failure'`,
        );
        await ctx.store.reserveTenantTelemetryExternalMutation(
          authorization(claim!), claim!.target.adapterProtocol,
        );
        try {
          await expect(ctx.store.completeTenantTelemetryWrite(
            authorization(claim!),
            adapterResult(claim!),
          )).rejects.toThrow("injected telemetry ACK failure");
        } finally {
          await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
        }
        await expect(ctx.store.getTenantTelemetryWriteJob(
          tenantId,
          queued.writeOperationSha256,
        )).resolves.toMatchObject({ phase: "queued" });
        const [counts] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_write_payloads
               WHERE write_operation_sha256=?) AS payloads,
             (SELECT COUNT(*) FROM tenant_telemetry_write_acks
               WHERE write_operation_sha256=?) AS acks,
             (SELECT COUNT(*) FROM tenant_telemetry_artifact_inventory
               WHERE inventory_sha256=?) AS inventories`,
          [queued.writeOperationSha256, queued.writeOperationSha256,
            queued.inventory.inventorySha256],
        );
        expect(Number(counts[0]?.payloads)).toBe(1);
        expect(Number(counts[0]?.acks)).toBe(0);
        expect(Number(counts[0]?.inventories)).toBe(0);
        await expect(ctx.store.completeTenantTelemetryWrite(
          authorization(claim!),
          adapterResult(claim!),
        )).resolves.toMatchObject({ writeOperationSha256: queued.writeOperationSha256 });
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("binds renew, retry and block transitions to the live claim attempt", async () => {
      const ctx = await fixture();
      try {
        const tenantId = "mysql-writer-transitions";
        await ctx.store.createApiKey(tenantId, "key", digest("transition-key"));
        const queued = await ctx.store.enqueueTenantTelemetryArtifact(
          input(tenantId, "transitions"),
        );
        const [first] = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "mysql-writer-transition-1",
          adapterProtocol: "telemetry-test-v1",
        });
        await ctx.store.reserveTenantTelemetryExternalMutation(
          authorization(first!), first!.target.adapterProtocol,
        );
        await expect(ctx.store.renewTenantTelemetryWrite(
          authorization(first!),
          { leaseMs: 120_000 },
        )).resolves.toBe(true);
        await expect(ctx.store.retryTenantTelemetryWrite(
          authorization(first!),
          { delayMs: 0, errorCode: "temporary_failure" },
        )).resolves.toBe(true);
        await expect(ctx.store.renewTenantTelemetryWrite(
          authorization(first!),
          { leaseMs: 120_000 },
        )).resolves.toBe(false);
        const [second] = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "mysql-writer-transition-2",
          adapterProtocol: "telemetry-test-v1",
        });
        expect(second!.claimAttempt).toBe(first!.claimAttempt + 1);
        await expect(ctx.store.blockTenantTelemetryWrite(
          authorization(first!),
        )).resolves.toBe(false);
        await expect(ctx.store.blockTenantTelemetryWrite(
          authorization(second!),
        )).resolves.toBe(true);
        await expect(ctx.store.getTenantTelemetryWriteJob(
          tenantId,
          queued.writeOperationSha256,
        )).resolves.toMatchObject({
          phase: "blocked",
          attempts: 2,
          blockedReasonCode: "integrity_conflict",
        });
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("keeps a persisted external-mutation reservation write-once under direct SQL", async () => {
      const ctx = await fixture();
      try {
        const tenantId = "mysql-writer-reservation-write-once";
        await ctx.store.createApiKey(tenantId, "key", digest("reservation-write-once-key"));
        const queued = await ctx.store.enqueueTenantTelemetryArtifact(
          input(tenantId, "reservation-write-once"),
        );
        const [claim] = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "mysql-writer-reservation-write-once",
          adapterProtocol: "telemetry-test-v1",
        });
        const reservation = await ctx.store.reserveTenantTelemetryExternalMutation(
          authorization(claim!),
          claim!.target.adapterProtocol,
        );
        expect(reservation).toBeDefined();

        const [beforeRows] = await ctx.conn.query<Row[]>(
          `SELECT mutation_adapter_protocol,mutation_started_at_db_ms,
                  mutation_started_claim_attempt,mutation_started_claim_token_sha256,
                  mutation_reservation_receipt_sha256
             FROM tenant_telemetry_write_jobs
            WHERE write_operation_sha256=?`,
          [queued.writeOperationSha256],
        );
        expect(beforeRows).toHaveLength(1);

        await expect(ctx.conn.query(
          `UPDATE tenant_telemetry_write_jobs
              SET mutation_reservation_receipt_sha256=NULL
            WHERE write_operation_sha256=?`,
          [queued.writeOperationSha256],
        )).rejects.toThrow(/tenant telemetry mutation reservation is invalid/);
        await expect(ctx.conn.query(
          `UPDATE tenant_telemetry_write_jobs
              SET mutation_adapter_protocol=NULL,mutation_started_at_db_ms=NULL,
                  mutation_started_claim_attempt=NULL,
                  mutation_started_claim_token_sha256=NULL,
                  mutation_reservation_receipt_sha256=NULL
            WHERE write_operation_sha256=?`,
          [queued.writeOperationSha256],
        )).rejects.toThrow(/tenant telemetry mutation reservation is invalid/);
        await expect(ctx.conn.query(
          `UPDATE tenant_telemetry_write_jobs
              SET mutation_reservation_receipt_sha256=?
            WHERE write_operation_sha256=?`,
          [digest("tampered-reservation-receipt"), queued.writeOperationSha256],
        )).rejects.toThrow(/tenant telemetry mutation reservation is invalid/);

        const [afterRows] = await ctx.conn.query<Row[]>(
          `SELECT mutation_adapter_protocol,mutation_started_at_db_ms,
                  mutation_started_claim_attempt,mutation_started_claim_token_sha256,
                  mutation_reservation_receipt_sha256
             FROM tenant_telemetry_write_jobs
            WHERE write_operation_sha256=?`,
          [queued.writeOperationSha256],
        );
        expect(afterRows).toEqual(beforeRows);
        await expect(ctx.store.getTenantTelemetryWriteJob(
          tenantId,
          queued.writeOperationSha256,
        )).resolves.toMatchObject({ reservation });
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("rejects an expired ABA claim while allowing the next attempt to complete", async () => {
      const ctx = await fixture();
      try {
        const tenantId = "mysql-writer-aba";
        await ctx.store.createApiKey(tenantId, "key", digest("aba-key"));
        await ctx.store.enqueueTenantTelemetryArtifact(input(tenantId, "aba"));
        const [first] = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "mysql-writer-aba-1",
          adapterProtocol: "telemetry-test-v1",
        });
        const reservation = await ctx.store.reserveTenantTelemetryExternalMutation(
          authorization(first!), first!.target.adapterProtocol,
        );
        expect(reservation).toBeDefined();
        const [expired] = await ctx.conn.query<mysql.ResultSetHeader>(
          `UPDATE tenant_telemetry_write_jobs
              SET lease_until_ms=updated_at_ms
            WHERE write_operation_sha256=? AND tenant_id=? AND phase='queued'
              AND attempts=? AND claim_token=?`,
          [
            first!.writeOperationSha256,
            tenantId,
            first!.claimAttempt,
            first!.claimToken,
          ],
        );
        expect(expired.affectedRows).toBe(1);
        const [second] = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "mysql-writer-aba-2",
          adapterProtocol: "telemetry-test-v1",
        });
        expect(second!.claimAttempt).toBe(first!.claimAttempt + 1);
        expect(second!.reservation).toEqual(reservation);
        await expect(ctx.store.completeTenantTelemetryWrite(
          authorization(first!),
          adapterResult(first!),
        )).resolves.toBeNull();
        await expect(ctx.store.completeTenantTelemetryWrite(
          authorization(second!),
          adapterResult(second!),
        )).resolves.toMatchObject({ completedClaimAttempt: 2 });
      } finally {
        await ctx.close();
      }
    }, 45_000);

    it("serializes a first-mutation reservation ahead of a concurrent tenant T1", async () => {
      const ctx = await fixture();
      const tenantId = "mysql-writer-reservation-t1-race";
      const gateName = `telemetry_reservation_${randomUUID().replaceAll("-", "")}`;
      const triggerName = `test_telemetry_reservation_gate_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      let gateHeld = false;
      let triggerCreated = false;
      let reservationSettled = false;
      let t1Settled = false;
      let pendingReservation: Promise<Awaited<ReturnType<
        typeof ctx.store.reserveTenantTelemetryExternalMutation
      >>> | undefined;
      let pendingT1: Promise<Awaited<ReturnType<
        typeof ctx.store.requestTenantErasure
      >>> | undefined;
      try {
        await ctx.store.createApiKey(tenantId, "key", digest("reservation-t1-race-key"));
        await ctx.store.enqueueTenantTelemetryArtifact(input(tenantId, "reservation-t1-race"));
        const [claim] = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "mysql-writer-reservation-t1-race",
          adapterProtocol: "telemetry-test-v1",
        });
        expect(claim).toBeDefined();
        const [gateRows] = await ctx.conn.query<Row[]>(
          "SELECT GET_LOCK(?,5) AS acquired",
          [gateName],
        );
        expect(Number(gateRows[0]?.acquired)).toBe(1);
        gateHeld = true;
        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\`
             BEFORE UPDATE ON tenant_telemetry_write_jobs FOR EACH ROW
           BEGIN
             IF OLD.mutation_reservation_receipt_sha256 IS NULL
                AND NEW.mutation_reservation_receipt_sha256 IS NOT NULL THEN
               SET @telemetry_reservation_gate = GET_LOCK('${gateName}',20);
               IF @telemetry_reservation_gate IS NULL OR @telemetry_reservation_gate<>1 THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT='telemetry reservation gate timed out';
               END IF;
               SET @telemetry_reservation_release = RELEASE_LOCK('${gateName}');
             END IF;
           END`,
        );
        triggerCreated = true;

        pendingReservation = ctx.store.reserveTenantTelemetryExternalMutation(
          authorization(claim!),
          claim!.target.adapterProtocol,
        ).finally(() => { reservationSettled = true; });
        await waitForBlockedQuery(ctx.conn, ["User lock"]);
        expect(reservationSettled).toBe(false);

        pendingT1 = ctx.store.requestTenantErasure({
          requestId: newErasureRequestId(),
          tenantId,
          requestedByKeyId: "mysql-writer-test",
          idempotencyKey: randomUUID(),
          requestHash: tenantErasureRequestHash(tenantId),
          atMs: Date.now(),
        }).finally(() => { t1Settled = true; });
        await waitForSubjectLifecycleLockWaiter(ctx.conn, ctx.database);
        expect(reservationSettled).toBe(false);
        expect(t1Settled).toBe(false);

        const [releaseRows] = await ctx.conn.query<Row[]>(
          "SELECT RELEASE_LOCK(?) AS released",
          [gateName],
        );
        expect(Number(releaseRows[0]?.released)).toBe(1);
        gateHeld = false;
        await expect(pendingReservation).resolves.toMatchObject({
          writeOperationSha256: claim!.writeOperationSha256,
          startedClaimAttempt: claim!.claimAttempt,
        });
        await expect(pendingT1).resolves.toMatchObject({ tenantId });
        await expect(ctx.store.completeTenantTelemetryWrite(
          authorization(claim!),
          adapterResult(claim!),
        )).resolves.toMatchObject({ tenantId });
      } finally {
        if (gateHeld) await ctx.conn.query("SELECT RELEASE_LOCK(?)", [gateName]).catch(() => {});
        const pending: Promise<unknown>[] = [];
        if (pendingReservation) pending.push(pendingReservation);
        if (pendingT1) pending.push(pendingT1);
        await Promise.allSettled(pending);
        if (triggerCreated) {
          await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
        }
        await ctx.close();
      }
    }, 45_000);

    it("blocks new enqueue after T1 but closes an already external-written claim", async () => {
      const ctx = await fixture();
      try {
        const tenantId = "mysql-writer-t1";
        await ctx.store.createApiKey(tenantId, "key", digest("t1-key"));
        await ctx.store.enqueueTenantTelemetryArtifact(input(tenantId, "before-t1"));
        const [claim] = await ctx.store.claimTenantTelemetryWriteJobs({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "mysql-writer-before-t1",
          adapterProtocol: "telemetry-test-v1",
        });
        await ctx.store.reserveTenantTelemetryExternalMutation(
          authorization(claim!), claim!.target.adapterProtocol,
        );
        await ctx.store.requestTenantErasure({
          requestId: newErasureRequestId(),
          tenantId,
          requestedByKeyId: "mysql-writer-test",
          idempotencyKey: randomUUID(),
          requestHash: tenantErasureRequestHash(tenantId),
          atMs: Date.now(),
        });
        await expect(ctx.store.enqueueTenantTelemetryArtifact(
          input(tenantId, "after-t1"),
        )).rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(ctx.store.completeTenantTelemetryWrite(
          authorization(claim!),
          adapterResult(claim!),
        )).resolves.toMatchObject({ tenantId });
        await expect(ctx.store.enqueueTenantTelemetryArtifact(
          input("mysql-writer-legacy", "legacy"),
        )).rejects.toBeInstanceOf(TenantTelemetryWriteConflictError);
      } finally {
        await ctx.close();
      }
    }, 45_000);
  });
}
