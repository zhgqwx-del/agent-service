import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeRevocationFleetProof,
} from "@agent-service/protocol";
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
  tenantErasureRequestHash,
  type TenantCredentialRevocationClaim,
  type TenantRuntimeRevocationAuthorization,
  type TenantRuntimeRevocationClaim,
} from "../src/index.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
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

function credentialAuthorization(claim: TenantCredentialRevocationClaim) {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function runtimeAuthorization(claim: TenantRuntimeRevocationClaim): TenantRuntimeRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function fleetProof(claim: TenantRuntimeRevocationClaim): TenantRuntimeRevocationFleetProof {
  const targets = [1, 2].map((index) => {
    const body = {
      targetSha256: tenantRuntimeTargetSha256(`http://mysql-runner-${index}.internal:8080`),
      runnerId: `mysql-runner-${index}`,
      bootId: `mysql-boot-${index}`,
      requestId: claim.requestId,
      tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration,
      t3aReceiptSha256: claim.t3aReceiptSha256,
      cacheEntryCountBefore: index,
      cacheEntryCountAfter: 0 as const,
      activeOperationCountBefore: index - 1,
      activeOperationCountAfter: 0 as const,
      activeTurnCountBefore: index + 1,
      activeTurnCountAfter: 0 as const,
      completedAtMs: Date.now() + index,
    };
    return { ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) };
  }).sort((left, right) => left.targetSha256.localeCompare(right.targetSha256, "en"));
  return {
    fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
    targets,
  };
}

function conflictingReplayProof(
  proof: TenantRuntimeRevocationFleetProof,
): TenantRuntimeRevocationFleetProof {
  const changed = structuredClone(proof);
  changed.targets[0]!.completedAtMs += 1;
  changed.targets[0]!.receiptSha256 = tenantRuntimeLocalReceiptSha256(changed.targets[0]!);
  changed.targetReceiptsSha256 = tenantRuntimeTargetReceiptsSha256(changed.targets);
  return changed;
}

async function advanceThroughT3a(
  store: MysqlSessionStore,
  tenantId: string,
): Promise<{ requestId: string }> {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  const request = {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `runtime-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  };
  await store.requestTenantErasure(request);
  const claim = (await store.claimTenantCredentialRevocations({
    limit: 100,
    leaseMs: 60_000,
    claimToken: `credential-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === request.requestId);
  expect(claim).toBeDefined();
  expect(await store.revokeTenantCredentialMaterial(credentialAuthorization(claim!)))
    .not.toBeNull();
  return { requestId: request.requestId };
}

async function seedRuntimeJob(
  store: MysqlSessionStore,
  tenantId: string,
  leaseMs = 60_000,
): Promise<{ requestId: string; claim: TenantRuntimeRevocationClaim }> {
  const source = await advanceThroughT3a(store, tenantId);
  expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 100 })).toBe(1);
  const claim = (await store.claimTenantRuntimeRevocations({
    limit: 100,
    leaseMs,
    claimToken: `runtime-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === source.requestId);
  expect(claim).toBeDefined();
  return { ...source, claim: claim! };
}

async function databaseNow(conn: Connection): Promise<number> {
  const [rows] = await conn.query<(RowDataPacket & { now_ms: number })[]>(
    "SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms",
  );
  const value = Number(rows[0]?.now_ms);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid test database clock");
  return value;
}

async function waitForBlockedQuery(
  observer: Connection,
  fragments: string[],
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<RowDataPacket[]>("SHOW FULL PROCESSLIST");
    if (rows.some((row) => {
      const info = String(row.Info ?? row.info ?? "");
      return fragments.every((fragment) => info.includes(fragment));
    })) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for blocked MySQL query: ${fragments.join(" / ")}`);
}

async function waitUntilDatabaseTimePasses(
  observer: Connection,
  timestampMs: number,
): Promise<void> {
  while (await databaseNow(observer) <= timestampMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant runtime revocation", () => {
    let baseUrl: URL;
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";

    beforeAll(async () => {
      baseUrl = assertDisposableTestTarget(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
    });

    beforeEach(async () => {
      database = `agent_service_runtime_test_${process.pid}_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_runtime_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe runtime test database name");
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

    it("atomically persists the complete fleet and replays only exact authority after lifecycle removal", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-runtime-success-${randomUUID()}`;
      try {
        const fixture = await seedRuntimeJob(store, tenantId);
        const authorization = runtimeAuthorization(fixture.claim);
        const proof = fleetProof(fixture.claim);
        const receipt = await store.completeTenantRuntimeRevocation(authorization, proof);
        expect(receipt).toMatchObject({
          tenantId,
          requestId: fixture.requestId,
          targetCount: 2,
          memoryDisposition: "references_dropped_not_zeroized",
          externalDisposition: "not_supported",
          contentPurgeRequired: true,
        });
        const [counts] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_runtime_revocation_target_receipts
               WHERE request_id=?) AS targets,
             (SELECT COUNT(*) FROM tenant_runtime_revocation_receipts
               WHERE request_id=?) AS receipts,
             (SELECT COUNT(*) FROM tenant_runtime_revocation_jobs
               WHERE request_id=? AND phase='configured_fleet_quiesced') AS terminal_jobs`,
          [fixture.requestId, fixture.requestId, fixture.requestId],
        );
        expect({
          targets: Number(counts[0]!.targets),
          receipts: Number(counts[0]!.receipts),
          terminalJobs: Number(counts[0]!.terminal_jobs),
        }).toEqual({ targets: 2, receipts: 1, terminalJobs: 1 });
        const [durableTargets] = await conn.query<RowDataPacket[]>(
          `SELECT target_sha256, runner_id_sha256, boot_id_sha256
             FROM tenant_runtime_revocation_target_receipts
            WHERE request_id=? ORDER BY target_sha256`,
          [fixture.requestId],
        );
        expect(durableTargets).toHaveLength(2);
        expect(durableTargets.every((row) => (
          /^[0-9a-f]{64}$/.test(String(row.runner_id_sha256))
          && /^[0-9a-f]{64}$/.test(String(row.boot_id_sha256))
        ))).toBe(true);
        expect(JSON.stringify(durableTargets)).not.toContain("mysql-runner-");
        expect(JSON.stringify(durableTargets)).not.toContain("mysql-boot-");
        expect(await store.completeTenantRuntimeRevocation(authorization, proof)).toEqual(receipt);
        await expect(store.completeTenantRuntimeRevocation(
          authorization,
          conflictingReplayProof(proof),
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await store.completeTenantRuntimeRevocation({
          ...authorization,
          claimToken: "wrong-response-loss-token",
        }, proof)).toBeNull();
        await conn.query(
          `DELETE FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [tenantId, tenantId],
        );
        expect(await store.getTenantRuntimeRevocationReceipt(tenantId, fixture.requestId))
          .toEqual(receipt);
        expect(await store.completeTenantRuntimeRevocation(authorization, proof)).toEqual(receipt);
        expect(await store.getTenantRuntimeRevocationReceipt("other-tenant", fixture.requestId))
          .toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("grants one concurrent claim and fences stale ABA authority", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-runtime-claim-${randomUUID()}`;
      try {
        const source = await advanceThroughT3a(first, tenantId);
        await first.materializeTenantRuntimeRevocationJobs({ limit: 10 });
        const [left, right] = await Promise.all([
          first.claimTenantRuntimeRevocations({ limit: 1, leaseMs: 60_000, claimToken: "left" }),
          second.claimTenantRuntimeRevocations({ limit: 1, leaseMs: 60_000, claimToken: "right" }),
        ]);
        const claims = [...left, ...right].filter((claim) => claim.requestId === source.requestId);
        expect(claims).toHaveLength(1);
        const stale = claims[0]!;
        await conn.query(
          `UPDATE tenant_runtime_revocation_jobs
              SET lease_until_ms=0, updated_at_ms=GREATEST(updated_at_ms, 1)
            WHERE request_id=?`,
          [source.requestId],
        );
        const [reclaimed] = await second.claimTenantRuntimeRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: stale.claimToken,
        });
        expect(reclaimed).toMatchObject({ claimAttempt: 2, claimToken: stale.claimToken });
        expect(await first.completeTenantRuntimeRevocation(
          runtimeAuthorization(stale),
          fleetProof(stale),
        )).toBeNull();
      } finally {
        await conn.end();
        await first.close();
        await second.close();
      }
    });

    it("skips a locked queue head and claims the next runtime job exactly once", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const observer = await mysql.createConnection(mysqlUrl);
      let blockerOpen = false;
      let pendingClaim: Promise<TenantRuntimeRevocationClaim[]> | undefined;
      try {
        const left = await advanceThroughT3a(store, `tenant-runtime-skip-left-${randomUUID()}`);
        const right = await advanceThroughT3a(store, `tenant-runtime-skip-right-${randomUUID()}`);
        expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(2);
        const [ordered] = await observer.query<RowDataPacket[]>(
          `SELECT request_id, tenant_id
             FROM tenant_runtime_revocation_jobs
            WHERE request_id IN (?, ?)
            ORDER BY available_at_ms, request_id`,
          [left.requestId, right.requestId],
        );
        expect(ordered).toHaveLength(2);
        const first = ordered[0]!;
        const second = ordered[1]!;

        await blocker.beginTransaction();
        blockerOpen = true;
        await blocker.query(
          `SELECT request_id FROM tenant_runtime_revocation_jobs
            WHERE request_id=? AND tenant_id=? FOR UPDATE`,
          [String(first.request_id), String(first.tenant_id)],
        );
        pendingClaim = store.claimTenantRuntimeRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "runtime-skip-second",
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const claims = await Promise.race([
          pendingClaim,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("runtime claim waited on a locked queue head")),
              2_000,
            );
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        expect(claims).toHaveLength(1);
        expect(claims[0]).toMatchObject({
          requestId: String(second.request_id),
          tenantId: String(second.tenant_id),
          claimAttempt: 1,
        });
        expect(await store.claimTenantRuntimeRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "runtime-skip-no-duplicate",
        })).toEqual([]);

        await blocker.commit();
        blockerOpen = false;
        await expect(store.claimTenantRuntimeRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "runtime-skip-first",
        })).resolves.toMatchObject([{
          requestId: String(first.request_id),
          tenantId: String(first.tenant_id),
          claimAttempt: 1,
        }]);
      } finally {
        if (blockerOpen) await blocker.rollback().catch(() => {});
        await pendingClaim?.catch(() => {});
        await observer.end();
        await blocker.end();
        await store.close();
      }
    });

    it("rechecks the database clock after job-lock waits before every claim-bound mutation", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const observer = await mysql.createConnection(mysqlUrl);
      const blockers: Connection[] = [];
      const leaseMs = 1_200;
      try {
        for (const action of ["renew", "retry", "block", "complete"] as const) {
          const tenantId = `tenant-runtime-${action}-lock-${randomUUID()}`;
          const fixture = await seedRuntimeJob(store, tenantId, leaseMs);
          const authorization = runtimeAuthorization(fixture.claim);
          const blocker = await mysql.createConnection(mysqlUrl);
          blockers.push(blocker);
          await blocker.beginTransaction();
          await blocker.query(
            `SELECT request_id FROM tenant_runtime_revocation_jobs
              WHERE request_id=? AND tenant_id=? FOR UPDATE`,
            [fixture.requestId, tenantId],
          );

          const pending = action === "renew"
            ? store.renewTenantRuntimeRevocation(authorization, { leaseMs: 60_000 })
            : action === "retry"
              ? store.retryTenantRuntimeRevocation(authorization, {
                delayMs: 0,
                errorCode: "temporary_failure",
              })
              : action === "block"
                ? store.blockTenantRuntimeRevocation(authorization)
                : store.completeTenantRuntimeRevocation(
                  authorization,
                  fleetProof(fixture.claim),
                );
          await waitForBlockedQuery(observer, [
            "FROM tenant_runtime_revocation_jobs",
            "FOR UPDATE",
          ]);
          expect(await databaseNow(observer)).toBeLessThan(fixture.claim.leaseUntilMs);
          await waitUntilDatabaseTimePasses(observer, fixture.claim.leaseUntilMs);
          await blocker.commit();
          await expect(pending).resolves.toBe(action === "complete" ? null : false);
          expect(await store.getTenantRuntimeRevocationJob(tenantId, fixture.requestId))
            .toMatchObject({
              phase: "queued",
              claimToken: fixture.claim.claimToken,
              leaseUntilMs: fixture.claim.leaseUntilMs,
              attempts: fixture.claim.claimAttempt,
            });
          await blocker.end();
          blockers.pop();
        }
      } finally {
        for (const blocker of blockers) {
          await blocker.rollback().catch(() => {});
          await blocker.end().catch(() => {});
        }
        await observer.end();
        await store.close();
      }
    }, 20_000);

    it("rolls target and aggregate inserts back when the terminal transition fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-runtime-rollback-${randomUUID()}`;
      try {
        const fixture = await seedRuntimeJob(store, tenantId);
        await conn.query(
          `CREATE TRIGGER trg_test_runtime_terminal_failure
             BEFORE UPDATE ON tenant_runtime_revocation_jobs FOR EACH ROW
             SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected runtime terminal failure'`,
        );
        await expect(store.completeTenantRuntimeRevocation(
          runtimeAuthorization(fixture.claim),
          fleetProof(fixture.claim),
        )).rejects.toThrow(/injected runtime terminal failure/i);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_runtime_revocation_target_receipts) AS targets,
             (SELECT COUNT(*) FROM tenant_runtime_revocation_receipts) AS receipts,
             (SELECT phase FROM tenant_runtime_revocation_jobs WHERE request_id=?) AS phase`,
          [fixture.requestId],
        );
        expect({
          targets: Number(rows[0]!.targets),
          receipts: Number(rows[0]!.receipts),
          phase: String(rows[0]!.phase),
        }).toEqual({ targets: 0, receipts: 0, phase: "queued" });
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS trg_test_runtime_terminal_failure");
        await conn.end();
        await store.close();
      }
    });

    it("fails closed before claim when the live deleting projection is missing", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-runtime-source-${randomUUID()}`;
      const completionTenantId = `tenant-runtime-completion-source-${randomUUID()}`;
      try {
        const completion = await seedRuntimeJob(store, completionTenantId);
        const source = await advanceThroughT3a(store, tenantId);
        await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
        await conn.query(
          `DELETE FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [tenantId, tenantId],
        );
        await expect(store.claimTenantRuntimeRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "missing-live-source",
        })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await store.getTenantRuntimeRevocationReceipt(tenantId, source.requestId)).toBeNull();

        await conn.query(
          `DELETE FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [completionTenantId, completionTenantId],
        );
        await expect(store.completeTenantRuntimeRevocation(
          runtimeAuthorization(completion.claim),
          fleetProof(completion.claim),
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [completionRows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_runtime_revocation_target_receipts
               WHERE request_id=?) AS targets,
             (SELECT COUNT(*) FROM tenant_runtime_revocation_receipts
               WHERE request_id=?) AS receipts`,
          [completion.requestId, completion.requestId],
        );
        expect(Number(completionRows[0]!.targets)).toBe(0);
        expect(Number(completionRows[0]!.receipts)).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore tenant runtime revocation", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with local MySQL running to enable", () => {});
  });
}
