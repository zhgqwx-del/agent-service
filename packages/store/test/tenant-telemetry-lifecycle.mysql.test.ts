import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection as Connection } from "./fixtures/capture-mysql-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  MysqlSessionStore,
  SessionGoneError,
  TENANT_TELEMETRY_RETENTION_CLASS,
  TenantTelemetryLifecycleConflictError,
  TenantTelemetryLifecycleIntegrityError,
  TenantErasureTargetNotFoundError,
  newErasureRequestId,
  tenantErasureRequestHash,
  userErasureRequestHash,
} from "../src/index.js";
import { mkSession } from "./conformance.js";

const BASE_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const REF_KEY = Buffer.alloc(32, 0x33);
type Row = RowDataPacket;

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${database}`);
  }
  return url;
}

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function activation(marker = "primary") {
  return {
    expectedControlGeneration: 0 as const,
    targets: [
      {
        domain: "logs" as const,
        backendKind: "test_sink",
        adapterProtocol: "telemetry-test-v1",
        namespaceSha256: digest(`${marker}:logs:namespace`),
        failureDomainSha256: digest(`${marker}:logs:failure-domain`),
      },
      {
        domain: "traces" as const,
        backendKind: "test_sink",
        adapterProtocol: "telemetry-test-v1",
        namespaceSha256: digest(`${marker}:traces:namespace`),
        failureDomainSha256: digest(`${marker}:traces:failure-domain`),
      },
    ],
  };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant telemetry lifecycle", () => {
    let base: URL;
    type Scope = { signal: AbortSignal; failed: boolean; failure?: { reason: unknown };
      owner?: CaptureMysqlRuntimeOwner; close?: Promise<void>; work?: Promise<void>; detach?: () => void;
      cleanupValidation?: "structure-after-intentional-data-corruption-v1" };
    const cases = new Set<Scope>();
    function finish(scope: Scope): Promise<void> {
      return scope.close ??= (async () => {
        try { await scope.owner?.close({ successful: !scope.failed && !scope.signal.aborted,
          ...(scope.cleanupValidation ? { cleanupValidation: scope.cleanupValidation } : {}) }); }
        finally { scope.detach?.(); }
      })();
    }
    function runCase(body: (scope: Scope) => Promise<void>) {
      return (context: TestContext): Promise<void> => {
        const scope: Scope = { signal: context.signal, failed: false }; cases.add(scope);
        const work = Promise.resolve().then(async () => {
          try { scope.signal.throwIfAborted(); await body(scope); scope.signal.throwIfAborted(); }
          catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          try { await finish(scope); } catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          if (scope.failure) throw scope.failure.reason;
        });
        scope.work = work; return work;
      };
    }
    beforeAll(async () => { base = disposableBase(BASE_URL); });
    afterAll(async () => {
      await Promise.allSettled([...cases].map(scope => scope.work!));
      const results = await Promise.allSettled([...cases].map(scope => finish(scope)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    function createOwner(scope: Scope, refKey: Uint8Array | null = REF_KEY): CaptureMysqlRuntimeOwner {
      const owner = new CaptureMysqlRuntimeOwner(base.toString(), { tenantTelemetryRefKey: refKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: false, tenantTelemetryCaptureRestoreLocalOnly: false });
      scope.owner = owner;
      const abort = () => { void owner.close({ successful: false }).catch(() => { /* finish joins the same original close. */ }); };
      scope.signal.addEventListener("abort", abort, { once: true });
      scope.detach = () => scope.signal.removeEventListener("abort", abort);
      scope.signal.throwIfAborted(); return owner;
    }

    async function fixture(scope: Scope, options: { withKey?: boolean } = {}): Promise<{
      database: string; url: string; store: MysqlSessionStore; conn: Connection; owner: CaptureMysqlRuntimeOwner; close(): Promise<void>;
    }> {
      const owner = createOwner(scope, options.withKey === false ? null : REF_KEY), database = owner.database;
      await owner.prepare(); const url = owner.runtimeEnv().MYSQL_URL!;
      const store = await owner.openStore(8, scope.signal), conn = await owner.openInspection(scope.signal);
      return { database, url, store, conn, owner, async close() { await finish(scope); } };
    }

    it("is dormant without the stable key", runCase(async scope => {
      const noKey = await fixture(scope, { withKey: false });
      try {
        expect(await noKey.store.getTenantTelemetryLifecycleControl()).toEqual({
          singletonId: 1,
          state: "inactive",
          controlGeneration: 0,
        });
        await expect(noKey.store.activateTenantTelemetryLifecycle(activation()))
          .rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await noKey.close();
      }
    }));

    it("activates with exact replay", runCase(async scope => {
      const ctx = await fixture(scope);
      try {
        const legacy = mkSession("tenant-telemetry-legacy", "user-telemetry-legacy");
        await ctx.store.createSession(legacy);
        const activated = await ctx.store.activateTenantTelemetryLifecycle(activation());
        expect(activated.control).toMatchObject({
          state: "active",
          controlGeneration: 1,
          targetCount: 2,
        });
        expect(activated.targets.map((target) => target.domain)).toEqual(["logs", "traces"]);
        expect(activated.receipt).toMatchObject({ coverageCount: 1 });
        expect(await ctx.store.getTenantTelemetryLifecycleCoverage(legacy.tenantId))
          .toMatchObject({ historyStatus: "legacy_history_unknown" });
        expect(await ctx.store.activateTenantTelemetryLifecycle(activation())).toEqual(activated);
        await expect(ctx.store.activateTenantTelemetryLifecycle(activation("conflict")))
          .rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);

        const current = mkSession("tenant-telemetry-current", "user-telemetry-current");
        await ctx.store.createSession(current);
        expect(await ctx.store.getTenantTelemetryLifecycleCoverage(current.tenantId))
          .toMatchObject({ historyStatus: "complete_since_creation" });
        await ctx.store.setLegalHold({
          tenantId: "tenant-telemetry-hold-first",
          holdId: "hold_telemetry_first",
          subjectKind: "tenant",
          subjectId: "tenant-telemetry-hold-first",
          reasonCode: "litigation",
          expectedControlGeneration: 0,
          actorKeyId: "hold-admin",
          atMs: Date.now(),
        });
        expect(await ctx.store.getTenantTelemetryLifecycleCoverage(
          "tenant-telemetry-hold-first",
        )).toMatchObject({ historyStatus: "complete_since_creation" });
        expect(await ctx.store.activateTenantTelemetryLifecycle(activation())).toEqual(activated);

        const reopened = await ctx.owner.openStore(2, scope.signal);
        try {
          expect(await reopened.getTenantTelemetryLifecycleControl()).toEqual(activated.control);
        } finally {
          await reopened.close();
        }
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("keeps inactive T1 subject-free and atomically closes it during activation", runCase(async scope => {
      const ctx = await fixture(scope);
      try {
        const session = mkSession(
          "tenant-telemetry-preactivation-subject",
          "user-telemetry-preactivation-subject",
        );
        await ctx.store.createApiKey(
          session.tenantId,
          "telemetry-preactivation-key",
          digest("telemetry-preactivation-key"),
        );
        await ctx.store.createSession(session);
        const input = {
          requestId: newErasureRequestId(),
          tenantId: session.tenantId,
          requestedByKeyId: "telemetry-subject-test",
          idempotencyKey: `telemetry-preactivation-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(session.tenantId),
          atMs: Date.now(),
        };
        const admission = await ctx.store.requestTenantErasure(input);
        expect(await ctx.store.getTenantTelemetryLifecycleSubject(
          session.tenantId,
          admission.requestId,
        )).toBeNull();
        const [dormantRows] = await ctx.conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM tenant_telemetry_lifecycle_subjects",
        );
        expect(Number(dormantRows[0]?.count)).toBe(0);

        const activated = await ctx.store.activateTenantTelemetryLifecycle(activation());
        expect(await ctx.store.getTenantTelemetryLifecycleSubject(
          session.tenantId,
          admission.requestId,
        )).toMatchObject({
          requestId: admission.requestId,
          tenantId: session.tenantId,
          subjectGeneration: admission.generation,
          targetRootSha256: activated.control.targetRootSha256,
        });
        expect(await ctx.store.getTenantTelemetryLifecycleSubject(
          "tenant-telemetry-other",
          admission.requestId,
        )).toBeNull();
        expect(await ctx.store.requestTenantErasure(input)).toEqual(admission);

        const reopened = await ctx.owner.openStore(2, scope.signal);
        await reopened.close();
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("rolls back active T1 when subject publication fails", runCase(async scope => {
      const ctx = await fixture(scope);
      try {
        await ctx.store.activateTenantTelemetryLifecycle(activation());
        const session = mkSession(
          "tenant-telemetry-subject-rollback",
          "user-telemetry-subject-rollback",
        );
        await ctx.store.createApiKey(
          session.tenantId,
          "telemetry-subject-rollback-key",
          digest("telemetry-subject-rollback-key"),
        );
        await ctx.store.createSession(session);
        const input = {
          requestId: newErasureRequestId(),
          tenantId: session.tenantId,
          requestedByKeyId: "telemetry-subject-test",
          idempotencyKey: `telemetry-subject-rollback-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(session.tenantId),
          atMs: Date.now(),
        };
        const triggerName = `test_telemetry_subject_rollback_${randomUUID()
          .replaceAll("-", "").slice(0, 8)}`;
        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT
             ON tenant_telemetry_lifecycle_subjects FOR EACH ROW
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected telemetry subject failure'`,
        );
        try {
          await expect(ctx.store.requestTenantErasure(input))
            .rejects.toThrow("injected telemetry subject failure");
        } finally {
          await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
        }
        const [rows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE tenant_id=?) AS admissions,
             (SELECT COUNT(*) FROM tenant_credential_revocation_fences WHERE tenant_id=?) AS fences,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_subjects WHERE tenant_id=?) AS subjects,
             (SELECT state FROM subject_lifecycle
               WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?) AS lifecycle_state`,
          [session.tenantId, session.tenantId, session.tenantId,
            session.tenantId, session.tenantId],
        );
        expect(Number(rows[0]?.admissions)).toBe(0);
        expect(Number(rows[0]?.fences)).toBe(0);
        expect(Number(rows[0]?.subjects)).toBe(0);
        expect(String(rows[0]?.lifecycle_state)).toBe("active");
        await expect(ctx.store.requestTenantErasure(input)).resolves.toMatchObject({
          requestId: input.requestId,
        });
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("publishes no partial state on serialization or SQL rollback failure", runCase(async scope => {
      const ctx = await fixture(scope);
      try {
        const invalid = activation() as ReturnType<typeof activation> & { callback?: () => void };
        invalid.callback = () => {};
        await expect(ctx.store.activateTenantTelemetryLifecycle(invalid as never)).rejects.toThrow();

        const session = mkSession("tenant-telemetry-rollback", "user-telemetry-rollback");
        await ctx.store.createSession(session);
        const triggerName = `test_telemetry_rollback_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT
             ON tenant_telemetry_lifecycle_coverages FOR EACH ROW
           BEGIN
             IF NEW.tenant_id = ? THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected telemetry coverage failure';
             END IF;
           END`,
          [session.tenantId],
        );
        try {
          await expect(ctx.store.activateTenantTelemetryLifecycle(activation()))
            .rejects.toThrow("injected telemetry coverage failure");
        } finally {
          await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
        }
        expect(await ctx.store.getTenantTelemetryLifecycleControl()).toEqual({
          singletonId: 1,
          state: "inactive",
          controlGeneration: 0,
        });
        const [counts] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_targets) AS targets,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages) AS coverages,
             (SELECT COUNT(*) FROM tenant_telemetry_activation_receipts) AS receipts`,
        );
        expect(Number(counts[0]?.targets)).toBe(0);
        expect(Number(counts[0]?.coverages)).toBe(0);
        expect(Number(counts[0]?.receipts)).toBe(0);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("serializes concurrent activation to one coherent winner", runCase(async scope => {
      const ctx = await fixture(scope);
      let contender: MysqlSessionStore | undefined;
      try {
        await ctx.store.createSession(mkSession("tenant-telemetry-race", "user-race"));
        contender = await ctx.owner.openStore(4, scope.signal);
        const settled = await Promise.allSettled([
          ctx.store.activateTenantTelemetryLifecycle(activation("winner-a")),
          contender.activateTenantTelemetryLifecycle(activation("winner-b")),
        ]);
        expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);

        const control = await ctx.store.getTenantTelemetryLifecycleControl();
        const targets = await ctx.store.listTenantTelemetryLifecycleTargets();
        expect(control).toMatchObject({ state: "active", targetCount: 2 });
        expect(targets).toHaveLength(2);
        const [counts] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_targets) AS targets,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages) AS coverages,
             (SELECT COUNT(*) FROM tenant_telemetry_activation_receipts) AS receipts`,
        );
        expect(Number(counts[0]?.targets)).toBe(2);
        expect(Number(counts[0]?.coverages)).toBe(1);
        expect(Number(counts[0]?.receipts)).toBe(1);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await contender?.close();
        await ctx.close();
      }
    }));

    it("serializes activation against the first writer without leaving a coverage gap", runCase(async scope => {
      const ctx = await fixture(scope);
      let contender: MysqlSessionStore | undefined;
      try {
        contender = await ctx.owner.openStore(4, scope.signal);
        const session = mkSession("tenant-telemetry-first-writer-race", "user-first-writer-race");
        const retryDeadlock = async <T>(work: () => Promise<T>): Promise<T> => {
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await work();
            } catch (error) {
              if ((error as { code?: string }).code !== "ER_LOCK_DEADLOCK" || attempt >= 2) {
                throw error;
              }
            }
          }
        };
        await Promise.all([
          retryDeadlock(() => ctx.store.activateTenantTelemetryLifecycle(activation())),
          retryDeadlock(() => contender!.createSession(session)),
        ]);

        const coverage = await ctx.store.getTenantTelemetryLifecycleCoverage(session.tenantId);
        expect(coverage).toMatchObject({
          tenantId: session.tenantId,
          targetCount: 2,
        });
        expect(["legacy_history_unknown", "complete_since_creation"])
          .toContain(coverage?.historyStatus);
        const [rows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM subject_lifecycle
               WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?) AS lifecycle_count,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages
               WHERE tenant_id=?) AS coverage_count`,
          [session.tenantId, session.tenantId, session.tenantId],
        );
        expect(Number(rows[0]?.lifecycle_count)).toBe(1);
        expect(Number(rows[0]?.coverage_count)).toBe(1);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await contender?.close();
        await ctx.close();
      }
    }));

    it("serializes concurrent tenant admissions without losing active telemetry coverage", runCase(async scope => {
      const ctx = await fixture(scope);
      try {
        await ctx.store.activateTenantTelemetryLifecycle(activation());
        const session = mkSession(
          "tenant-telemetry-admission-race",
          "user-telemetry-admission-race",
        );
        await ctx.store.setTenantAuth(session.tenantId, DEFAULT_AUTH_POLICY);
        await ctx.store.createSession(session);
        const inputs = [0, 1].map(() => ({
          requestId: newErasureRequestId(),
          tenantId: session.tenantId,
          requestedByKeyId: "telemetry-admission-test",
          idempotencyKey: `telemetry-admission-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(session.tenantId),
          atMs: Date.now(),
        }));

        const results = await Promise.all(
          inputs.map((input) => ctx.store.requestTenantErasure(input)),
        );
        expect(new Set(results.map((result) => result.requestId))).toHaveLength(1);
        expect(await ctx.store.getTenantTelemetryLifecycleCoverage(session.tenantId))
          .toMatchObject({
            tenantId: session.tenantId,
            historyStatus: "complete_since_creation",
          });
        const subject = await ctx.store.getTenantTelemetryLifecycleSubject(
          session.tenantId,
          results[0]!.requestId,
        );
        expect(subject).toMatchObject({
          requestId: results[0]!.requestId,
          tenantId: session.tenantId,
          subjectGeneration: results[0]!.generation,
        });
        expect(await ctx.store.getTenantTelemetryLifecycleSubject(
          "tenant-telemetry-other",
          results[0]!.requestId,
        )).toBeNull();
        const [rows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE tenant_id=?)
               AS admission_count,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages WHERE tenant_id=?)
               AS coverage_count,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_subjects WHERE tenant_id=?)
               AS subject_count`,
          [session.tenantId, session.tenantId, session.tenantId],
        );
        expect(Number(rows[0]?.admission_count)).toBe(1);
        expect(Number(rows[0]?.coverage_count)).toBe(1);
        expect(Number(rows[0]?.subject_count)).toBe(1);

        const reopened = await ctx.owner.openStore(2, scope.signal);
        await reopened.close();
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("keeps active telemetry coverage isolated from tenant collation aliases", runCase(async scope => {
      const ctx = await fixture(scope);
      try {
        await ctx.store.activateTenantTelemetryLifecycle(activation());
        const suffix = randomUUID().replaceAll("-", "");
        const tenantId = `tenant-telemetry-r\u00e9sum\u00e9-${suffix}`;
        const aliasTenantId = tenantId.normalize("NFD");
        expect(aliasTenantId).not.toBe(tenantId);
        await ctx.store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        const before = await ctx.store.getTenantTelemetryLifecycleCoverage(tenantId);
        expect(before).toMatchObject({
          tenantId,
          historyStatus: "complete_since_creation",
        });

        await expect(ctx.store.requestTenantErasure({
          requestId: newErasureRequestId(),
          tenantId: aliasTenantId,
          requestedByKeyId: "telemetry-alias-test",
          idempotencyKey: `telemetry-alias-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(aliasTenantId),
          atMs: Date.now(),
        })).rejects.toBeInstanceOf(TenantErasureTargetNotFoundError);

        expect(await ctx.store.getTenantTelemetryLifecycleCoverage(tenantId)).toEqual(before);
        const [rows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages
               WHERE BINARY tenant_id=BINARY ?) AS canonical_coverage_count,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages
               WHERE BINARY tenant_id=BINARY ?) AS alias_coverage_count,
             (SELECT COUNT(*) FROM tenant_erasure_admissions
               WHERE BINARY tenant_id=BINARY ?) AS alias_admission_count`,
          [tenantId, aliasTenantId, aliasTenantId],
        );
        expect(Number(rows[0]?.canonical_coverage_count)).toBe(1);
        expect(Number(rows[0]?.alias_coverage_count)).toBe(0);
        expect(Number(rows[0]?.alias_admission_count)).toBe(0);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("binds immutable artifacts to exact session ownership without cross-tenant disclosure", runCase(async scope => {
      const ctx = await fixture(scope);
      try {
        await ctx.store.activateTenantTelemetryLifecycle(activation());
        const owner = mkSession("tenant-telemetry-owner", "user-telemetry-owner");
        const other = mkSession("tenant-telemetry-other", "user-telemetry-other");
        await ctx.store.createSession(owner);
        await ctx.store.createSession(other);
        const input = {
          tenantId: owner.tenantId,
          expectedControlGeneration: 1 as const,
          domain: "logs" as const,
          artifactIdSha256: digest("artifact-stable-id"),
          artifactGeneration: 1,
          ownerKind: "session" as const,
          ownerId: owner.id,
          ownerUserId: owner.userId,
          sourceSchema: "test-export-v1",
          sourceGeneration: 1,
          sourceHighWaterDbMs: Date.now(),
          payloadSha256: digest("artifact-payload"),
          manifestSha256: digest("artifact-manifest"),
        };
        const record = await ctx.store.registerTenantTelemetryArtifact(input);
        expect(record).toMatchObject({
          tenantId: owner.tenantId,
          ownerKind: "session",
          retentionClass: TENANT_TELEMETRY_RETENTION_CLASS,
          disposeAfterDbMs: null,
          historyStatus: "complete_since_creation",
        });
        expect(record.ownerRefSha256).not.toBe(record.holdSubjectRefSha256);
        expect(await ctx.store.registerTenantTelemetryArtifact(input)).toEqual(record);
        expect(await ctx.store.getTenantTelemetryArtifact(
          owner.tenantId,
          input.domain,
          input.artifactIdSha256,
          input.artifactGeneration,
        )).toEqual(record);
        expect(await ctx.store.getTenantTelemetryArtifact(
          other.tenantId,
          input.domain,
          input.artifactIdSha256,
          input.artifactGeneration,
        )).toBeNull();

        await expect(ctx.store.registerTenantTelemetryArtifact({
          ...input,
          tenantId: other.tenantId,
          ownerId: other.id,
          ownerUserId: other.userId,
        })).rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);
        await expect(ctx.store.registerTenantTelemetryArtifact({
          ...input,
          artifactIdSha256: digest("session-owner-mismatch"),
          ownerUserId: other.userId,
        })).rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);

        await ctx.store.requestUserErasure({
          requestId: newErasureRequestId(),
          tenantId: owner.tenantId,
          userId: owner.userId,
          requestedByKeyId: "admin-key",
          idempotencyKey: "telemetry-gated-owner",
          requestHash: userErasureRequestHash(owner.tenantId, owner.userId),
          atMs: Date.now(),
        });
        await expect(ctx.store.registerTenantTelemetryArtifact(input)).resolves.toEqual(record);
        await expect(ctx.store.registerTenantTelemetryArtifact({
          ...input,
          artifactIdSha256: digest("gated-user-new-artifact"),
        })).rejects.toBeInstanceOf(SessionGoneError);

        const deletedInput = {
          ...input,
          tenantId: other.tenantId,
          ownerId: other.id,
          ownerUserId: other.userId,
          artifactIdSha256: digest("deleted-session-existing-artifact"),
        };
        const deletedRecord = await ctx.store.registerTenantTelemetryArtifact(deletedInput);
        await ctx.conn.query(
          `UPDATE sessions
              SET deleted_at_ms=?,deletion_generation=1
            WHERE session_id=?`,
          [Date.now(), other.id],
        );
        await expect(ctx.store.registerTenantTelemetryArtifact(deletedInput))
          .resolves.toEqual(deletedRecord);
        await expect(ctx.store.registerTenantTelemetryArtifact({
          ...deletedInput,
          artifactIdSha256: digest("deleted-session-new-artifact"),
        })).rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);

        await expect(ctx.owner.openStore(20, scope.signal, { tenantTelemetryRefKey: Buffer.alloc(32, 0x44) })).rejects.toThrow(/exact stable ref key/);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("never heals an existing lifecycle row that is missing atomic coverage", runCase(async scope => {
      scope.cleanupValidation = "structure-after-intentional-data-corruption-v1";
      const ctx = await fixture(scope);
      try {
        const active = await ctx.store.activateTenantTelemetryLifecycle(activation());
        const tenantId = "tenant-telemetry-coverage-gap";
        const createdAtMs = active.control.activatedAtDbMs + 1;
        await ctx.conn.query(
          `INSERT INTO subject_lifecycle
             (tenant_id,subject_kind,subject_id,state,generation,active_request_id,
              legal_hold_at_ms,created_at_ms,updated_at_ms)
           VALUES (?,'tenant',?,'active',0,NULL,NULL,?,?)`,
          [tenantId, tenantId, createdAtMs, createdAtMs],
        );

        await expect(ctx.store.registerTenantTelemetryCoverage({
          tenantId,
          expectedControlGeneration: 1,
          historyStatus: "complete_since_creation",
        })).rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
        await expect(ctx.store.getTenantTelemetryLifecycleCoverage(tenantId))
          .rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
        await expect(ctx.owner.openStore(2, scope.signal)).rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
        const [rows] = await ctx.conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM tenant_telemetry_lifecycle_coverages WHERE tenant_id=?",
          [tenantId],
        );
        expect(Number(rows[0]?.count)).toBe(0);

        const mixedTenantId = "tenant-telemetry-mixed-writer";
        await ctx.conn.query(
          `INSERT INTO agent_versions
             (tenant_id,agent_id,version,definition,created_at_ms)
           VALUES (?,?,1,?,?)`,
          [mixedTenantId, "agent-default", JSON.stringify({}), createdAtMs],
        );
        await expect(ctx.store.createSession(
          mkSession(mixedTenantId, "user-mixed-writer"),
        )).rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
        const [mixedRows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM subject_lifecycle WHERE tenant_id=?) AS lifecycle_count,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages WHERE tenant_id=?)
               AS coverage_count,
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS session_count`,
          [mixedTenantId, mixedTenantId, mixedTenantId],
        );
        expect(Number(mixedRows[0]?.lifecycle_count)).toBe(0);
        expect(Number(mixedRows[0]?.coverage_count)).toBe(0);
        expect(Number(mixedRows[0]?.session_count)).toBe(0);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("fails closed on a missing active T1 subject during reads and startup", runCase(async scope => {
      scope.cleanupValidation = "structure-after-intentional-data-corruption-v1";
      const ctx = await fixture(scope);
      try {
        await ctx.store.activateTenantTelemetryLifecycle(activation());
        const session = mkSession(
          "tenant-telemetry-subject-gap",
          "user-telemetry-subject-gap",
        );
        await ctx.store.createApiKey(
          session.tenantId,
          "telemetry-subject-gap-key",
          digest("telemetry-subject-gap-key"),
        );
        await ctx.store.createSession(session);
        const admission = await ctx.store.requestTenantErasure({
          requestId: newErasureRequestId(),
          tenantId: session.tenantId,
          requestedByKeyId: "telemetry-subject-test",
          idempotencyKey: `telemetry-subject-gap-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(session.tenantId),
          atMs: Date.now(),
        });
        const [triggerRows] = await ctx.conn.query<Row[]>(
          "SHOW CREATE TRIGGER trg_tenant_telemetry_subjects_bd",
        );
        const triggerDdl = String(triggerRows[0]?.["SQL Original Statement"] ?? "");
        expect(triggerDdl).toContain("CREATE");
        await ctx.conn.query("DROP TRIGGER trg_tenant_telemetry_subjects_bd");
        await ctx.conn.query(
          "DELETE FROM tenant_telemetry_lifecycle_subjects WHERE request_id=?",
          [admission.requestId],
        );
        await ctx.conn.query(triggerDdl);

        await expect(ctx.store.getTenantTelemetryLifecycleSubject(
          session.tenantId,
          admission.requestId,
        )).rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
        await expect(ctx.store.getTenantErasureRequest(
          session.tenantId,
          admission.requestId,
        )).rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
        await expect(ctx.owner.openStore(2, scope.signal)).rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("fails startup and artifact writes when active receipt provenance is lost", runCase(async scope => {
      scope.cleanupValidation = "structure-after-intentional-data-corruption-v1";
      const ctx = await fixture(scope);
      try {
        await ctx.store.activateTenantTelemetryLifecycle(activation());
        const owner = mkSession("tenant-telemetry-receipt-gap", "user-receipt-gap");
        await ctx.store.createSession(owner);
        const [triggerRows] = await ctx.conn.query<Row[]>(
          "SHOW CREATE TRIGGER trg_tenant_telemetry_activation_bd",
        );
        const triggerDdl = String(triggerRows[0]?.["SQL Original Statement"] ?? "");
        expect(triggerDdl).toContain("CREATE");
        await ctx.conn.query("DROP TRIGGER trg_tenant_telemetry_activation_bd");
        await ctx.conn.query("DELETE FROM tenant_telemetry_activation_receipts");
        await ctx.conn.query(triggerDdl);

        await expect(ctx.store.registerTenantTelemetryArtifact({
          tenantId: owner.tenantId,
          expectedControlGeneration: 1,
          domain: "logs",
          artifactIdSha256: digest("receipt-gap-artifact"),
          artifactGeneration: 1,
          ownerKind: "session",
          ownerId: owner.id,
          ownerUserId: owner.userId,
          sourceSchema: "test-export-v1",
          sourceGeneration: 1,
          sourceHighWaterDbMs: Date.now(),
          payloadSha256: digest("receipt-gap-payload"),
          manifestSha256: digest("receipt-gap-manifest"),
        })).rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
        await expect(ctx.owner.openStore(2, scope.signal)).rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));
  });
} else {
  describe("MysqlSessionStore tenant telemetry lifecycle", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
