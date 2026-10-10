import { randomUUID } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  BlobStorageControlConflictError,
  MysqlSessionStore,
} from "../src/index.js";

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

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseName(): string {
  return `agent_service_blob_control_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function activation(namespaceSha256 = NAMESPACE, storageBackend = BACKEND) {
  return { expectedControlGeneration: 0 as const, storageBackend, namespaceSha256 };
}

async function insertBlob(
  conn: Connection,
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
  conn: Connection,
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
  conn: Connection,
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
  conn: Connection,
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

    async function fixture(): Promise<{
      database: string;
      url: string;
      store: MysqlSessionStore;
      conn: Connection;
      close(): Promise<void>;
    }> {
      const database = databaseName();
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      const url = databaseUrl(base, database);
      const store = await MysqlSessionStore.connect({ url, connectionLimit: 8 });
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

    it("activates once and exactly replays a lost response", async () => {
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
      } finally {
        await ctx.close();
      }
    });

    it("blocks every live or uncompleted foreign backend before publishing generation 1", async () => {
      const arrangements: Array<(conn: Connection) => Promise<void>> = [
        (conn) => insertBlob(conn, "live-blob", "filesystem-v1"),
        (conn) => insertArtifact(conn, "live-artifact", "filesystem-v1"),
        async (conn) => {
          await insertArtifact(conn, "live-part", BACKEND);
          await insertPart(conn, "live-part", "filesystem-v1");
        },
        (conn) => insertSnapshotBlob(conn, "legacy-pin", BACKEND, null),
        (conn) => insertSnapshotBlob(conn, "wrong-pin", "filesystem-v1", NAMESPACE),
        async (conn) => {
          await insertBlob(conn, "pending-blob", "filesystem-v1", "deleted");
          await conn.query(
            `INSERT INTO blob_delete_outbox
               (blob_id,generation,available_at_ms,attempts,created_at_ms)
             VALUES ('blob-pending-blob',1,1,0,1)`,
          );
        },
        async (conn) => {
          await conn.query(
            `INSERT INTO user_export_artifact_delete_outbox
               (artifact_id,part_number,request_id,build_generation,deletion_generation,
                storage_backend,storage_format,storage_key,upload_token,available_at_ms,
                attempts,created_at_ms)
             VALUES ('artifact-pending-export',0,'request-pending-export',1,1,?,?,
                     'data_exports/pending-export','upload-pending-export',1,0,1)`,
            ["filesystem-v1", BLOB_STORAGE_FORMAT],
          );
        },
        async (conn) => {
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
        },
      ];
      for (const arrange of arrangements) {
        const ctx = await fixture();
        try {
          await arrange(ctx.conn);
          await expect(ctx.store.activateBlobStorageControl(activation()))
            .rejects.toBeInstanceOf(BlobStorageControlConflictError);
          await expect(ctx.conn.query(
            `UPDATE blob_storage_control
                SET control_generation=1,storage_backend=?,namespace_sha256=?,
                    activated_at_db_ms=1,evidence_sha256=?
              WHERE singleton_id=1`,
            [BACKEND, NAMESPACE, "f".repeat(64)],
          )).rejects.toThrow(/inventory conflicts|snapshot conflicts|dead-letter/);
          expect(await ctx.store.getBlobStorageControl()).toEqual({
            singletonId: 1,
            controlGeneration: 0,
          });
        } finally {
          await ctx.close();
        }
      }
    }, 90_000);

    it("makes activation and all inventory checks one rollback boundary", async () => {
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
      } finally {
        await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await ctx.close();
      }
    });

    it("serializes competing activations and stale-snapshot old writers", async () => {
      const ctx = await fixture();
      const second = await MysqlSessionStore.connect({ url: ctx.url, connectionLimit: 4 });
      const stale = await mysql.createConnection(ctx.url);
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
      } finally {
        await stale.rollback().catch(() => {});
        await stale.end();
        await second.close();
        await ctx.close();
      }
    });

    it("allows only the active backend for new Blob, export artifact, and export part rows", async () => {
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
      } finally {
        await ctx.close();
      }
    });
  });
}
