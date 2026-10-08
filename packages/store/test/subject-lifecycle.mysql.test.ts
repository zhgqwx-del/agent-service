import { randomUUID } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  MysqlSessionStore,
  SessionGoneError,
  SubjectDeletingError,
  newErasureRequestId,
  userErasureRequestHash,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create subject lifecycle fixture database from base database "${database}": `
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

function requestInput(tenantId: string, userId: string, idempotencyKey = "erase-once") {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "admin-key",
    idempotencyKey,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs: 1_800_000_000_000,
  };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore subject lifecycle", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_subject_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_subject_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated subject lifecycle fixture database name");
      }
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(base, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterAll(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin?.end();
    });

    it("atomically gates a subject, audits once, replays, and hides normal owner access", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const target = mkSession(`tenant_subject_${randomUUID()}`, "User_Case");
      const neighbor = mkSession(target.tenantId, "user_case");
      await store.createSession(target);
      await store.createSession(neighbor);
      const input = requestInput(target.tenantId, target.userId, "shared-key");
      try {
        const created = await store.requestUserErasure(input);
        expect(created).toMatchObject({
          requestId: input.requestId,
          subjectKind: "user",
          subjectId: target.userId,
          generation: 1,
          status: "gated",
        });
        expect(await store.requestUserErasure({
          ...input,
          requestId: newErasureRequestId(),
          atMs: input.atMs + 1,
        })).toEqual(created);
        expect(await store.requestUserErasure({
          ...input,
          requestId: newErasureRequestId(),
          idempotencyKey: "different-key",
          atMs: input.atMs + 2,
        })).toEqual(created);
        expect(await store.listErasureAuditEvents(input.requestId)).toEqual([{
          requestId: input.requestId,
          seq: 1,
          type: "erasure/gated",
          payload: { status: "gated", subjectKind: "user", generation: 1 },
          emittedAtMs: input.atMs,
        }]);
        expect(await store.getUserErasureRequest(target.tenantId, target.userId, input.requestId)).toEqual(created);
        expect(await store.getUserErasureRequest(target.tenantId, neighbor.userId, input.requestId)).toBeNull();
        expect(await store.getSession(target.tenantId, target.id)).toBeNull();
        expect((await store.listSessions(target.tenantId, { userId: target.userId, limit: 10 })).data).toEqual([]);
        expect(await store.getSessionLifecycle(target.tenantId, target.userId, target.id)).toMatchObject({
          session: { id: target.id },
        });
        await expect(store.commit({ sessionId: target.id, fence: 1, sessionPatch: { title: "late" } }))
          .rejects.toBeInstanceOf(SessionGoneError);
        await expect(store.createSession(mkSession(target.tenantId, target.userId)))
          .rejects.toBeInstanceOf(SubjectDeletingError);

        await store.commit({ sessionId: neighbor.id, fence: 1, sessionPatch: { title: "neighbor" } });
        expect(await store.getSession(neighbor.tenantId, neighbor.id)).toMatchObject({ title: "neighbor" });
        const other = await store.requestUserErasure(requestInput(target.tenantId, neighbor.userId, "shared-key"));
        expect(other.requestId).not.toBe(created.requestId);

        const [counts] = await conn.query<(RowDataPacket & {
          requests: number; audits: number; deleting: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM erasure_requests WHERE tenant_id=?) AS requests,
             (SELECT COUNT(*) FROM erasure_audit_events) AS audits,
             (SELECT COUNT(*) FROM subject_lifecycle
               WHERE tenant_id=? AND subject_kind='user' AND state='deleting') AS deleting`,
          [target.tenantId, target.tenantId],
        );
        expect({
          requests: Number(counts[0]?.requests),
          audits: Number(counts[0]?.audits),
          deleting: Number(counts[0]?.deleting),
        }).toEqual({ requests: 2, audits: 2, deleting: 2 });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back the gate and request when the first audit insert fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant_subject_${randomUUID()}`, `user_${randomUUID()}`);
      await store.createSession(session);
      const input = requestInput(session.tenantId, session.userId, "rollback-key");
      try {
        await conn.query(
          `CREATE TRIGGER fail_erasure_audit BEFORE INSERT ON erasure_audit_events
           FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected erasure audit failure'`,
        );
        await expect(store.requestUserErasure(input)).rejects.toThrow("injected erasure audit failure");

        const lifecycle = await store.getSubjectLifecycle(session.tenantId, "user", session.userId);
        expect(lifecycle).toMatchObject({
          state: "active",
          generation: 0,
        });
        expect(lifecycle).not.toHaveProperty("activeRequestId");
        expect(await store.getUserErasureRequest(session.tenantId, session.userId, input.requestId)).toBeNull();
        expect(await store.listErasureAuditEvents(input.requestId)).toEqual([]);
        expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ id: session.id });

        await conn.query("DROP TRIGGER fail_erasure_audit");
        expect(await store.requestUserErasure(input)).toMatchObject({ status: "gated", generation: 1 });
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS fail_erasure_audit").catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("keeps lifecycle time monotonic when a clock-behind runner gates and replays", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const lifecycleAtMs = 2_000_000_000_000;
      const session = {
        ...mkSession(`tenant_subject_${randomUUID()}`, `user_${randomUUID()}`),
        createdAtMs: lifecycleAtMs,
        updatedAtMs: lifecycleAtMs,
      };
      await store.createSession(session);
      const input = {
        ...requestInput(session.tenantId, session.userId, "clock-skew-key"),
        atMs: lifecycleAtMs - 1_000,
      };
      try {
        const created = await store.requestUserErasure(input);
        expect(created).toMatchObject({
          createdAtMs: input.atMs,
          gatedAtMs: input.atMs,
          updatedAtMs: input.atMs,
        });
        expect(await store.getSubjectLifecycle(session.tenantId, "user", session.userId)).toMatchObject({
          state: "deleting",
          createdAtMs: lifecycleAtMs,
          updatedAtMs: lifecycleAtMs,
        });
        expect(await store.requestUserErasure({
          ...input,
          requestId: newErasureRequestId(),
          atMs: input.atMs - 1_000,
        })).toEqual(created);
        expect(await store.listErasureAuditEvents(input.requestId)).toEqual([
          expect.objectContaining({ emittedAtMs: input.atMs }),
        ]);
      } finally {
        await store.close();
      }
    });

    it("linearizes concurrent gate and create without a visible post-gate session", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_subject_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const existing = mkSession(tenantId, userId);
      const raced = mkSession(tenantId, userId);
      await firstStore.createSession(existing);
      const input = requestInput(tenantId, userId, "race-key");
      try {
        const [gated, created] = await Promise.allSettled([
          firstStore.requestUserErasure(input),
          secondStore.createSession(raced),
        ]);
        expect(gated.status).toBe("fulfilled");
        if (created.status === "rejected") expect(created.reason).toBeInstanceOf(SubjectDeletingError);
        else expect(created.value.lastSeq).toBe(1); // creation linearized entirely before the gate

        expect(await firstStore.getSession(tenantId, existing.id)).toBeNull();
        expect(await firstStore.getSession(tenantId, raced.id)).toBeNull();
        const internalRaced = await firstStore.getSessionLifecycle(tenantId, userId, raced.id);
        expect(internalRaced === null || internalRaced.session.lastSeq === 1).toBe(true);
        await expect(secondStore.createSession(mkSession(tenantId, userId)))
          .rejects.toBeInstanceOf(SubjectDeletingError);
      } finally {
        await secondStore.close();
        await firstStore.close();
      }
    });

    it("keeps an interrupted upload staged and blocks new Blob mutations after the subject gate", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const session = mkSession(`tenant_subject_${randomUUID()}`, `user_${randomUUID()}`);
      await store.createSession(session);
      const interruptedBlobId = newId("blob");
      const uploadToken = `upload-${interruptedBlobId.slice(5)}`;
      try {
        await store.stageBlob({
          owner: { tenantId: session.tenantId, userId: session.userId },
          sessionId: session.id,
          fence: 1,
          blobId: interruptedBlobId,
          purpose: "tool_output",
          storageBackend: "memory-v1",
          storageFormat: BLOB_STORAGE_FORMAT,
          storageKey: `objects/${interruptedBlobId.slice(5)}`,
          uploadToken,
          createdAtMs: 100,
          stagingExpiresAtMs: 60_100,
        });
        await store.requestUserErasure(requestInput(session.tenantId, session.userId, "blob-gate"));

        await expect(store.markBlobUploaded({
          owner: { tenantId: session.tenantId, userId: session.userId },
          sessionId: session.id,
          fence: 1,
          blobId: interruptedBlobId,
          uploadToken,
          sha256: "a".repeat(64),
          sizeBytes: 3,
          contentType: "application/json",
          uploadedAtMs: 200,
        })).rejects.toBeInstanceOf(SessionGoneError);
        const interruptedManifest = await store.getBlobManifest(interruptedBlobId);
        expect(interruptedManifest).toMatchObject({ state: "staging" });
        expect(interruptedManifest).not.toHaveProperty("uploadedAtMs");

        const blobId = newId("blob");
        await expect(store.stageBlob({
          owner: { tenantId: session.tenantId, userId: session.userId },
          sessionId: session.id,
          fence: 1,
          blobId,
          purpose: "tool_output",
          storageBackend: "memory-v1",
          storageFormat: BLOB_STORAGE_FORMAT,
          storageKey: `objects/${blobId.slice(5)}`,
          uploadToken: `upload-${blobId.slice(5)}`,
          createdAtMs: 100,
          stagingExpiresAtMs: 60_100,
        })).rejects.toBeInstanceOf(SessionGoneError);
        expect(await store.getBlobManifest(blobId)).toBeNull();
      } finally {
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore subject lifecycle", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
