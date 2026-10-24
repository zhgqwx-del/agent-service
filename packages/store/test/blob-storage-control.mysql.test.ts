import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  BlobStorageControlConflictError,
} from "../src/index.js";
import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection } from "./fixtures/capture-mysql-runtime.js";

const BASE_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const BACKEND = `s3v1-${"a".repeat(24)}`;
const NAMESPACE = "b".repeat(64);
type Row = RowDataPacket;

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${database}`);
  }
  return url;
}

function activation(namespaceSha256 = NAMESPACE, storageBackend = BACKEND) {
  return { expectedControlGeneration: 0 as const, storageBackend, namespaceSha256 };
}

async function insertBlob(
  conn: CaptureMysqlInspection,
  suffix: string,
  storageBackend: string,
  state: "staging" | "ready" | "delete_pending" | "deleted" = "ready",
): Promise<void> {
  await conn.query(
    `INSERT INTO blob_objects
       (blob_id,tenant_id,user_id,session_id,item_id,purpose,storage_backend,storage_format,
        storage_key,upload_token,state,deletion_generation,created_at_ms,deleted_at_ms)
     VALUES (?,?,?,?,NULL,'tool_output',?,?,?,? ,?,0,1,?)`,
    [
      `blob-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      `session-${suffix}`,
      storageBackend,
      BLOB_STORAGE_FORMAT,
      `objects/${suffix}`,
      `upload-${suffix}`,
      state,
      state === "deleted" ? 2 : null,
    ],
  );
}

async function insertArtifact(
  conn: CaptureMysqlInspection,
  suffix: string,
  storageBackend: string,
  state: "staging" | "ready" | "delete_pending" | "deleted" = "staging",
): Promise<void> {
  await conn.query(
    `INSERT INTO user_export_artifacts
       (artifact_id,request_id,tenant_id,user_id,subject_generation,build_generation,
        export_format,export_schema_version,content_type,content_encoding,storage_backend,
        storage_format,state,part_count,record_count,total_size_bytes,snapshot_root_sha256,
        policy_version,policy_sha256,artifact_ttl_ms,staging_expires_at_ms,deleted_at_ms,
        deletion_generation,created_at_ms,updated_at_ms)
     VALUES (?,?,?,?,1,1,'ndjson-v1',1,'application/x-ndjson','identity',?,?,?,0,0,0,?,
             'policy-v1',?,1000,2000,?,0,1,1)`,
    [
      `artifact-${suffix}`,
      `request-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      storageBackend,
      BLOB_STORAGE_FORMAT,
      state,
      "c".repeat(64),
      "d".repeat(64),
      state === "deleted" ? 2 : null,
    ],
  );
}

async function insertPart(
  conn: CaptureMysqlInspection,
  suffix: string,
  storageBackend: string,
  state: "staging" | "uploaded" | "delete_pending" | "deleted" = "uploaded",
): Promise<void> {
  await conn.query(
    `INSERT INTO user_export_artifact_parts
       (artifact_id,part_number,request_id,build_generation,tenant_id,user_id,
        subject_generation,state,storage_backend,storage_format,storage_key,upload_token,
        content_encoding,staging_expires_at_ms,deleted_at_ms,deletion_generation,
        created_at_ms,updated_at_ms)
     VALUES (?,0,?,1,?,?,1,?,?,?,?,?,'identity',2000,?,0,1,1)`,
    [
      `artifact-${suffix}`,
      `request-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      state,
      storageBackend,
      BLOB_STORAGE_FORMAT,
      `data_exports/${suffix}`,
      `upload-${suffix}`,
      state === "deleted" ? 2 : null,
    ],
  );
}

async function insertSnapshotBlob(
  conn: CaptureMysqlInspection,
  suffix: string,
  storageBackend: string,
  storageNamespaceSha256: string | null,
  releasedAtMs: number | null = null,
): Promise<void> {
  await conn.query(
    `INSERT INTO user_export_snapshot_blobs
       (request_id,build_generation,ordinal,blob_id,tenant_id,user_id,subject_generation,
        session_id,item_id,purpose,storage_backend,storage_namespace_sha256,storage_format,
        storage_key,upload_token,source_deletion_generation,source_sha256,source_size_bytes,
        pin_token,pinned_at_ms,released_at_ms)
     VALUES (?,1,0,?,?,?,1,?,NULL,'tool_output',?,?,?,?,?,0,?,1,?,1,?)`,
    [
      `snapshot-request-${suffix}`,
      `snapshot-blob-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      `session-${suffix}`,
      storageBackend,
      storageNamespaceSha256,
      BLOB_STORAGE_FORMAT,
      `objects/snapshot-${suffix}`,
      `upload-snapshot-${suffix}`,
      "e".repeat(64),
      `pin-${suffix}`,
      releasedAtMs,
    ],
  );
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore Blob storage control", () => {
    let base: URL;
    type Scope = { signal: AbortSignal; owners: Set<CaptureMysqlRuntimeOwner>;
      detach: Array<() => void>; failed: boolean; settled: boolean; work?: Promise<void>;
      closing?: Promise<void>; cleanupReported?: boolean };
    const scopes = new Set<Scope>();
    let current: Scope | undefined;
    function scope(): Scope {
      if (!current) throw new Error("Blob control current case is not registered");
      return current;
    }
    async function finish(value: Scope): Promise<void> {
      value.closing ??= (async () => {
        const closed = await Promise.allSettled([...value.owners].map(owner => owner.close({
          successful: !value.failed && !value.signal.aborted,
        })));
        for (const detach of value.detach) detach();
        const error = closed.find(result => result.status === "rejected");
        if (error?.status === "rejected") throw error.reason;
      })();
      try { await value.closing; }
      catch (reason) {
        if (!value.failed) { value.failed = true; throw reason; }
        if (!value.cleanupReported) {
          value.cleanupReported = true;
          try { console.warn("blob_control_fixture_cleanup_failed_after_primary_failure"); }
          catch { /* Preserve the original body failure. */ }
        }
      }
    }
    function runCase(body: () => Promise<void>) {
      return (): Promise<void> => {
        const owned = scope();
        const work = Promise.resolve().then(async () => {
          try { owned.signal.throwIfAborted(); await body(); owned.signal.throwIfAborted(); }
          catch (reason) { owned.failed = true; throw reason; }
          finally { await finish(owned); }
        });
        owned.work = work;
        void work.then(() => { owned.settled = true; }, () => { owned.settled = true; });
        return work;
      };
    }
    beforeAll(() => { base = disposableBase(BASE_URL); });
    beforeEach(({ signal }) => {
      if ([...scopes].some(value => !value.settled)) throw new Error("Blob control prior case is not settled");
      current = { signal, owners: new Set(), detach: [], failed: false, settled: false };
      scopes.add(current);
    });
    afterEach(async () => {
      const value = scope();
      await Promise.allSettled(value.work ? [value.work] : []);
      await finish(value);
    });
    afterAll(async () => {
      await Promise.allSettled([...scopes].flatMap(value => value.work ? [value.work] : []));
      const closed = await Promise.allSettled([...scopes].map(value => finish(value)));
      const error = closed.find(result => result.status === "rejected");
      if (error?.status === "rejected") throw error.reason;
    });

    type FixtureObservationPhase = "fixture_prepare" | "fixture_store_open" | "fixture_inspection_open";
    async function fixture(observePhase?: (phase: FixtureObservationPhase) => void) {
      const observe = (phase: FixtureObservationPhase) => {
        try { observePhase?.(phase); } catch { /* Observation cannot affect native work. */ }
      };
      const value = scope();
      value.signal.throwIfAborted();
      const owner = new CaptureMysqlRuntimeOwner(base.toString(), {
        tenantTelemetryRefKey: null, tenantTelemetryPersistedProviderCaptureLocalOnly: false,
        tenantTelemetryCaptureRestoreLocalOnly: false,
      });
      value.owners.add(owner); // Own before witness/CREATE, including unknown or late preparation.
      const abort = () => { value.failed = true; void owner.close({ successful: false }).catch(() => {}); };
      value.signal.addEventListener("abort", abort, { once: true });
      value.detach.push(() => value.signal.removeEventListener("abort", abort));
      if (value.signal.aborted) abort();
      observe("fixture_prepare");
      await owner.prepare();
      observe("fixture_store_open");
      const store = await owner.openStore(8, value.signal);
      observe("fixture_inspection_open");
      const conn = await owner.openInspection(value.signal);
      return { database: owner.database, owner, store, conn, close: () => finish(value) };
    }

    it("activates once and exactly replays a lost response", runCase(async () => {
      const ctx = await fixture();
      try {
        // Released pre-cutover pins are historical metadata and do not retain readable source bytes.
        await insertSnapshotBlob(ctx.conn, "released-legacy", "filesystem-v1", null, 1);
        // A completion ACK, unlike dead-letter, proves the physical work is terminal and may remain
        // as foreign-backend history without blocking activation or exact response-loss replay.
        await ctx.conn.query(
          `INSERT INTO blob_delete_outbox
             (blob_id,generation,available_at_ms,attempts,completed_at_ms,created_at_ms)
           VALUES ('missing-completed-blob',1,1,1,2,1)`,
        );
        await ctx.conn.query(
          `INSERT INTO user_export_artifact_delete_outbox
             (artifact_id,part_number,request_id,build_generation,deletion_generation,
              storage_backend,storage_format,storage_key,upload_token,available_at_ms,
              attempts,completed_at_ms,created_at_ms)
           VALUES ('completed-foreign-export',0,'completed-foreign-request',1,1,
                   'filesystem-v1',?,'data_exports/completed-foreign',
                   'upload-completed-foreign',1,1,2,1)`,
          [BLOB_STORAGE_FORMAT],
        );
        expect(await ctx.store.getBlobStorageControl()).toEqual({
          singletonId: 1,
          controlGeneration: 0,
        });
        const active = await ctx.store.activateBlobStorageControl(activation());
        expect(active).toMatchObject({
          singletonId: 1,
          controlGeneration: 1,
          storageBackend: BACKEND,
          namespaceSha256: NAMESPACE,
          activatedAtDbMs: expect.any(Number),
          evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(await ctx.store.activateBlobStorageControl(activation())).toEqual(active);
        await expect(ctx.store.activateBlobStorageControl(activation("e".repeat(64))))
          .rejects.toBeInstanceOf(BlobStorageControlConflictError);
        await expect(ctx.conn.query(
          "UPDATE blob_storage_control SET namespace_sha256=? WHERE singleton_id=1",
          ["f".repeat(64)],
        )).rejects.toThrow(/write-once|inventory conflicts/);
        await expect(ctx.conn.query("DELETE FROM blob_storage_control WHERE singleton_id=1"))
          .rejects.toThrow(/cannot be deleted/);
      } catch (reason) { scope().failed = true; throw reason; } finally {
        await ctx.close();
      }
    }));

    // Each independent source gets its own fresh schema and default test budget.
    const arrangements: Array<{ label: string; arrange: (conn: CaptureMysqlInspection) => Promise<void> }> = [
      { label: "live foreign Blob", arrange: (conn) => insertBlob(conn, "live-blob", "filesystem-v1") },
      { label: "live foreign export artifact", arrange: (conn) => insertArtifact(conn, "live-artifact", "filesystem-v1") },
      { label: "live foreign export part", arrange: async (conn) => {
          await insertArtifact(conn, "live-part", BACKEND);
          await insertPart(conn, "live-part", "filesystem-v1");
        } },
      { label: "unreleased snapshot pin with missing namespace", arrange: (conn) => insertSnapshotBlob(conn, "legacy-pin", BACKEND, null) },
      { label: "unreleased foreign snapshot pin", arrange: (conn) => insertSnapshotBlob(conn, "wrong-pin", "filesystem-v1", NAMESPACE) },
      { label: "uncompleted foreign Blob delete", arrange: async (conn) => {
          await insertBlob(conn, "pending-blob", "filesystem-v1", "deleted");
          await conn.query(
            `INSERT INTO blob_delete_outbox
               (blob_id,generation,available_at_ms,attempts,created_at_ms)
             VALUES ('blob-pending-blob',1,1,0,1)`,
          );
        } },
      { label: "uncompleted foreign export delete", arrange: async (conn) => {
          await conn.query(
            `INSERT INTO user_export_artifact_delete_outbox
               (artifact_id,part_number,request_id,build_generation,deletion_generation,
                storage_backend,storage_format,storage_key,upload_token,available_at_ms,
                attempts,created_at_ms)
             VALUES ('artifact-pending-export',0,'request-pending-export',1,1,?,?,
                     'data_exports/pending-export','upload-pending-export',1,0,1)`,
            ["filesystem-v1", BLOB_STORAGE_FORMAT],
          );
        } },
      { label: "dead-lettered foreign export delete", arrange: async (conn) => {
          await conn.query(
            `INSERT INTO user_export_artifact_delete_outbox
               (artifact_id,part_number,request_id,build_generation,deletion_generation,
                storage_backend,storage_format,storage_key,upload_token,available_at_ms,
                attempts,last_error,dead_lettered_at_ms,created_at_ms)
             VALUES ('artifact-dead-letter-export',0,'request-dead-letter-export',1,1,?, ?,
                     'data_exports/dead-letter-export','upload-dead-letter-export',1,1,
                     'controlled terminal retry failure',2,1)`,
            ["filesystem-v1", BLOB_STORAGE_FORMAT],
          );
        } },
    ];
    for (const arrangement of arrangements) {
      it.each([arrangement])("blocks every live or uncompleted foreign backend before publishing generation 1: $label", ({ arrange, label }) => {
      const diagnostic = label !== "uncompleted foreign export delete" ? undefined : (() => {
        const owned = scope();
        type Phase = FixtureObservationPhase | "arrange" | "activate_conflict" | "direct_update_conflict"
          | "readback_generation_zero" | "fixture_close";
        type ObservedBy = "abort" | "body-error" | "test-failed";
        let phase: Phase = "fixture_prepare", began: number | undefined;
        try { const value = performance.now(); if (Number.isFinite(value)) began = value; }
        catch { /* Observation is optional. */ }
        const markPhase = (next: Phase) => { phase = next; };
        const snapshot = (observedBy: ObservedBy) => {
          if (began === undefined) return undefined;
          const elapsedMs = Math.max(0, Math.floor(performance.now() - began));
          if (!Number.isSafeInteger(elapsedMs)) return undefined;
          return { phase, elapsedMs, observedBy, signalAborted: owned.signal.aborted };
        };
        let firstDiagnostic: ReturnType<typeof snapshot>;
        const freeze = (observedBy: ObservedBy) => {
          try { firstDiagnostic ??= snapshot(observedBy); } catch { /* Preserve the original failure. */ }
        };
        const observeAbort = () => freeze("abort");
        // Register before fixture() attaches the owner's real cancellation listener.
        try {
          owned.detach.push(() => {
            try { owned.signal.removeEventListener("abort", observeAbort); } catch { /* Observation only. */ }
          });
          owned.signal.addEventListener("abort", observeAbort, { once: true });
          if (owned.signal.aborted) observeAbort();
        } catch { /* Observation cannot affect owner cancellation. */ }
        try {
          onTestFailed(() => {
            try {
              const observed = firstDiagnostic ?? snapshot("test-failed");
              if (observed) console.error(JSON.stringify({ schema: "mysql-case-phase-diagnostic-v1",
                caseLabel: "blob_storage_control_uncompleted_foreign_export_delete", ...observed }));
            } catch { /* Never replace the original test or cleanup failure. */ }
          });
        } catch { /* Diagnostic registration cannot affect the original case. */ }
        return { markPhase, freeze };
      })();
      return runCase(async () => {
      const ctx = await fixture(diagnostic?.markPhase);
      try {
        diagnostic?.markPhase("arrange");
        await arrange(ctx.conn);
        diagnostic?.markPhase("activate_conflict");
        await expect(ctx.store.activateBlobStorageControl(activation()))
          .rejects.toBeInstanceOf(BlobStorageControlConflictError);
        diagnostic?.markPhase("direct_update_conflict");
        await expect(ctx.conn.query(
          `UPDATE blob_storage_control
                SET control_generation=1,storage_backend=?,namespace_sha256=?,
                    activated_at_db_ms=1,evidence_sha256=?
              WHERE singleton_id=1`,
          [BACKEND, NAMESPACE, "f".repeat(64)],
        )).rejects.toThrow(/inventory conflicts|snapshot conflicts|dead-letter/);
        diagnostic?.markPhase("readback_generation_zero");
        expect(await ctx.store.getBlobStorageControl()).toEqual({
          singletonId: 1,
          controlGeneration: 0,
        });
      } catch (reason) { scope().failed = true; diagnostic?.freeze("body-error"); throw reason; } finally {
        diagnostic?.markPhase("fixture_close");
        await ctx.close();
      }
      })();
      }, arrangement.label === "uncompleted foreign export delete" ? 45_000 : undefined);
    }

    it("makes activation and all inventory checks one rollback boundary", runCase(async () => {
      const ctx = await fixture();
      const trigger = `test_blob_control_failure_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      try {
        await ctx.conn.query(
          `CREATE TRIGGER \`${trigger}\` AFTER UPDATE ON blob_storage_control
           FOR EACH ROW SIGNAL SQLSTATE '45000'
           SET MESSAGE_TEXT='controlled blob storage activation failure'`,
        );
        await expect(ctx.store.activateBlobStorageControl(activation()))
          .rejects.toThrow("controlled blob storage activation failure");
        expect(await ctx.store.getBlobStorageControl()).toEqual({
          singletonId: 1,
          controlGeneration: 0,
        });
        await ctx.conn.query(`DROP TRIGGER \`${trigger}\``);
        await expect(ctx.store.activateBlobStorageControl(activation())).resolves.toMatchObject({
          controlGeneration: 1,
        });
      } catch (reason) { scope().failed = true; throw reason; } finally {
        await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await ctx.close();
      }
    }));

    it("serializes competing activations and stale-snapshot old writers", runCase(async () => {
      const ctx = await fixture();
      const second = await ctx.owner.openStore(4, scope().signal);
      const stale = await ctx.owner.openInspection(scope().signal);
      try {
        await stale.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await stale.beginTransaction();
        const [before] = await stale.query<Row[]>(
          "SELECT control_generation FROM blob_storage_control WHERE singleton_id=1",
        );
        expect(Number(before[0]!.control_generation)).toBe(0);

        const [left, right] = await Promise.allSettled([
          ctx.store.activateBlobStorageControl(activation("1".repeat(64))),
          second.activateBlobStorageControl(activation("2".repeat(64))),
        ]);
        expect([left.status, right.status].sort()).toEqual(["fulfilled", "rejected"]);
        const active = await ctx.store.getBlobStorageControl();
        expect(active.controlGeneration).toBe(1);

        const [snapshot] = await stale.query<Row[]>(
          "SELECT control_generation FROM blob_storage_control WHERE singleton_id=1",
        );
        expect(Number(snapshot[0]!.control_generation)).toBe(0);
        await expect(insertBlob(stale, "stale-writer", "filesystem-v1"))
          .rejects.toThrow(/rejects backend/);
        await stale.rollback();
      } catch (reason) { scope().failed = true; throw reason; } finally {
        await stale.rollback().catch(() => {});
        await stale.end();
        await second.close();
        await ctx.close();
      }
    }));

    it("allows only the active backend for new Blob, export artifact, and export part rows", runCase(async () => {
      const ctx = await fixture();
      try {
        await ctx.store.activateBlobStorageControl(activation());
        await insertBlob(ctx.conn, "matching-blob", BACKEND);
        await insertArtifact(ctx.conn, "matching-export", BACKEND);
        await insertPart(ctx.conn, "matching-export", BACKEND);
        await insertSnapshotBlob(ctx.conn, "matching-snapshot", BACKEND, NAMESPACE);
        await ctx.conn.query(
          `INSERT INTO blob_delete_outbox
             (blob_id,generation,available_at_ms,attempts,created_at_ms)
           VALUES ('blob-matching-blob',1,1,0,1)`,
        );
        await ctx.conn.query(
          `INSERT INTO user_export_artifact_delete_outbox
             (artifact_id,part_number,request_id,build_generation,deletion_generation,
              storage_backend,storage_format,storage_key,upload_token,available_at_ms,
              attempts,created_at_ms)
           VALUES ('artifact-matching-delete',0,'request-matching-delete',1,1,?,?,
                   'data_exports/matching-delete','upload-matching-delete',1,0,1)`,
          [BACKEND, BLOB_STORAGE_FORMAT],
        );

        await expect(insertBlob(ctx.conn, "wrong-blob", "filesystem-v1"))
          .rejects.toThrow(/rejects backend/);
        await expect(insertArtifact(ctx.conn, "wrong-artifact", "filesystem-v1"))
          .rejects.toThrow(/rejects export backend/);
        await expect(insertPart(ctx.conn, "wrong-part", "filesystem-v1"))
          .rejects.toThrow(/rejects export part backend/);
        await expect(insertSnapshotBlob(
          ctx.conn,
          "missing-snapshot-namespace",
          BACKEND,
          null,
        )).rejects.toThrow(/rejects snapshot namespace/);
        await expect(insertSnapshotBlob(
          ctx.conn,
          "wrong-snapshot-namespace",
          BACKEND,
          "f".repeat(64),
        )).rejects.toThrow(/rejects snapshot namespace/);
        await expect(ctx.conn.query(
          `INSERT INTO blob_delete_outbox
             (blob_id,generation,available_at_ms,attempts,created_at_ms)
           VALUES ('blob-missing-after-active',1,1,0,1)`,
        )).rejects.toThrow(/rejects blob delete intent/);
        await expect(ctx.conn.query(
          `INSERT INTO user_export_artifact_delete_outbox
             (artifact_id,part_number,request_id,build_generation,deletion_generation,
              storage_backend,storage_format,storage_key,upload_token,available_at_ms,
              attempts,created_at_ms)
           VALUES ('artifact-wrong-delete',0,'request-wrong-delete',1,1,'filesystem-v1',?,
                   'data_exports/wrong-delete','upload-wrong-delete',1,0,1)`,
          [BLOB_STORAGE_FORMAT],
        )).rejects.toThrow(/rejects export delete intent/);
        await expect(ctx.conn.query(
          "UPDATE blob_objects SET storage_backend='filesystem-v1' WHERE blob_id='blob-matching-blob'",
        )).rejects.toThrow(/immutable or inactive/);
        await expect(ctx.conn.query(
          `UPDATE user_export_artifact_delete_outbox SET storage_backend='filesystem-v1'
            WHERE artifact_id='artifact-matching-delete'`,
        )).rejects.toThrow(/immutable or inactive/);
        await expect(ctx.conn.query(
          `UPDATE user_export_snapshot_blobs SET storage_namespace_sha256=?
            WHERE request_id='snapshot-request-matching-snapshot'`,
          ["f".repeat(64)],
        )).rejects.toThrow(/immutable or inactive/);
      } catch (reason) { scope().failed = true; throw reason; } finally {
        await ctx.close();
      }
    }));
  });
}
