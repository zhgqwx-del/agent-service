import { randomUUID } from "node:crypto";
import type { Approval, Item, Session, Turn } from "@agent-service/protocol";
import { emptyUsage } from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  BlobStateError,
  MysqlSessionStore,
  SessionGoneError,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const CONTENT_TYPE = "application/vnd.agent-service.tool-output+json";
const SHA256 = "a".repeat(64);

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create blob lifecycle fixture database from base database "${database}": `
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

function owner(session: Session) {
  return { tenantId: session.tenantId, userId: session.userId };
}

function blobFixture(session: Session, createdAtMs = Date.now(), expiresAtMs = createdAtMs + 60_000) {
  const blobId = newId("blob");
  return {
    owner: owner(session),
    sessionId: session.id,
    fence: 1,
    blobId,
    purpose: "tool_output" as const,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey: `objects/${blobId.slice("blob_".length)}`,
    uploadToken: `upload-${blobId.slice("blob_".length)}`,
    createdAtMs,
    stagingExpiresAtMs: expiresAtMs,
  };
}

async function stageAndUpload(
  store: MysqlSessionStore,
  session: Session,
  createdAtMs = Date.now(),
  expiresAtMs = createdAtMs + 60_000,
) {
  const staged = blobFixture(session, createdAtMs, expiresAtMs);
  await store.stageBlob(staged);
  await store.markBlobUploaded({
    owner: staged.owner,
    sessionId: staged.sessionId,
    fence: staged.fence,
    blobId: staged.blobId,
    uploadToken: staged.uploadToken,
    sha256: SHA256,
    sizeBytes: 42,
    contentType: CONTENT_TYPE,
    uploadedAtMs: createdAtMs + 1,
  });
  return staged;
}

function toolResult(session: Session, blobId: string, turnId = newId("turn")): Item {
  return {
    id: newId("item"),
    sessionId: session.id,
    turnId,
    seq: 0,
    step: 1,
    status: "completed",
    createdAtMs: 150,
    completedAtMs: 151,
    type: "toolResult",
    toolCallId: "call-large-output",
    name: "large_output",
    content: [],
    isError: false,
    outputRef: blobId,
  };
}

function turn(session: Session, id = newId("turn")): Turn {
  return {
    id,
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 0,
    toolCalls: 0,
    usage: emptyUsage(),
    startedAtMs: 100,
  };
}

function approval(session: Session, turnId: string, itemId: string, id = newId("apr")): Approval {
  return {
    id,
    sessionId: session.id,
    turnId,
    itemId,
    status: "pending",
    toolCallId: "call-approval",
    toolName: "dangerous",
    args: {},
    availableDecisions: ["accept", "decline"],
    createdAtMs: 100,
    expiresAtMs: 10_000,
  };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore blob lifecycle", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_blob_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_blob_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated blob lifecycle fixture database name");
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

    it("stages, uploads and atomically binds only an owner-scoped manifest", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const session = mkSession("tenant_blob_owner", "user_blob_owner");
      const other = mkSession("tenant_blob_other", "user_blob_other");
      try {
        await store.createSession(session);
        await store.createSession(other);
        const staged = blobFixture(session);

        await store.stageBlob(staged);
        await store.stageBlob(staged); // exact retry is idempotent
        expect(await store.getBlobManifest(staged.blobId)).toMatchObject({
          blobId: staged.blobId,
          tenantId: session.tenantId,
          userId: session.userId,
          sessionId: session.id,
          purpose: "tool_output",
          state: "staging",
          storageBackend: "memory-v1",
          storageFormat: BLOB_STORAGE_FORMAT,
          storageKey: staged.storageKey,
          uploadToken: staged.uploadToken,
          stagingExpiresAtMs: staged.stagingExpiresAtMs,
          deletionGeneration: 0,
        });
        expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ fenceToken: 1 });

        await expect(store.stageBlob({
          ...staged,
          owner: owner(other),
          sessionId: other.id,
        })).rejects.toBeInstanceOf(BlobStateError);
        await expect(store.markBlobUploaded({
          owner: owner(other),
          sessionId: session.id,
          fence: 1,
          blobId: staged.blobId,
          uploadToken: staged.uploadToken,
          sha256: SHA256,
          sizeBytes: 42,
          contentType: CONTENT_TYPE,
          uploadedAtMs: 101,
        })).rejects.toBeInstanceOf(SessionGoneError);

        const uploaded = {
          owner: staged.owner,
          sessionId: staged.sessionId,
          fence: staged.fence,
          blobId: staged.blobId,
          uploadToken: staged.uploadToken,
          sha256: SHA256,
          sizeBytes: 42,
          contentType: CONTENT_TYPE,
          uploadedAtMs: 101,
        };
        await store.markBlobUploaded(uploaded);
        await store.markBlobUploaded(uploaded); // descriptor-identical retry is idempotent
        expect(await store.getBindableBlob({
          owner: owner(session), sessionId: session.id, blobId: staged.blobId, purpose: "tool_output",
        })).toMatchObject({ sha256: SHA256, sizeBytes: 42, contentType: CONTENT_TYPE, state: "staging" });
        expect(await store.getBindableBlob({
          owner: owner(other), sessionId: session.id, blobId: staged.blobId, purpose: "tool_output",
        })).toBeNull();

        const item = toolResult(session, staged.blobId);
        await expect(store.commit({
          sessionId: session.id,
          fence: 1,
          items: [item],
          blobBindings: [],
          events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: 151, item }],
        })).rejects.toThrow("blob bindings must exactly match");
        expect(await store.getItem(session.id, item.id)).toBeNull();
        const stillStaging = await store.getBlobManifest(staged.blobId);
        expect(stillStaging).toMatchObject({ state: "staging" });
        expect(stillStaging?.itemId).toBeUndefined();

        const result = await store.commit({
          sessionId: session.id,
          fence: 2,
          items: [item],
          blobBindings: [{ blobId: staged.blobId, itemId: item.id, purpose: "tool_output" }],
          events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: 151, item }],
        });
        expect(result.events).toHaveLength(1);
        const readyManifest = await store.getBlobManifest(staged.blobId);
        expect(readyManifest).toMatchObject({
          state: "ready",
          itemId: item.id,
          readyAtMs: expect.any(Number),
        });
        expect(readyManifest?.stagingExpiresAtMs).toBeUndefined();
        expect(await store.getReadyBlob({
          owner: owner(session), sessionId: session.id, blobId: staged.blobId, itemId: item.id, purpose: "tool_output",
        })).toMatchObject({ blobId: staged.blobId, itemId: item.id, state: "ready" });
        expect(await store.getReadyBlob({
          owner: owner(other), sessionId: session.id, blobId: staged.blobId, itemId: item.id,
        })).toBeNull();
        expect(await store.scheduleStaleBlobDeletes({ nowMs: 1_000_000, limit: 10 })).toBe(0);
        expect(await store.getBlobDeleteOutbox(staged.blobId, 1)).toBeNull();
      } finally {
        await store.close();
      }
    });

    it("treats the staging deadline as a hard bind boundary and leaves the expired object cleanable", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const session = mkSession("tenant_blob_expired", "user_blob_expired");
      const now = Date.now();
      try {
        await store.createSession(session);
        const staged = await stageAndUpload(store, session, now - 60_000, now - 1_000);

        expect(await store.getBindableBlob({
          owner: owner(session), sessionId: session.id, blobId: staged.blobId, purpose: "tool_output",
        })).toBeNull();

        const item = toolResult(session, staged.blobId);
        await expect(store.commit({
          sessionId: session.id,
          fence: 2,
          items: [item],
          blobBindings: [{ blobId: staged.blobId, itemId: item.id, purpose: "tool_output" }],
          events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: now, item }],
        })).rejects.toBeInstanceOf(BlobStateError);
        expect(await store.getItem(session.id, item.id)).toBeNull();
        expect(await store.readEvents(session.id, 0, 10)).toEqual([
          { type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 },
        ]);
        expect(await store.getBlobManifest(staged.blobId)).toMatchObject({
          state: "staging",
          stagingExpiresAtMs: now - 1_000,
        });
        expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ lastSeq: 1, fenceToken: 1 });

        expect(await store.scheduleStaleBlobDeletes({ nowMs: now, limit: 10 })).toBe(1);
        expect(await store.getBlobManifest(staged.blobId)).toMatchObject({
          state: "delete_pending",
          deletionGeneration: 1,
        });
        expect(await store.getBlobDeleteOutbox(staged.blobId, 1)).toMatchObject({
          blobId: staged.blobId,
          generation: 1,
        });
        const [cleanup] = await store.claimBlobDeletes({
          nowMs: now,
          limit: 1,
          leaseMs: 100,
          claimToken: "expired-bind-cleanup",
        });
        expect(cleanup).toMatchObject({ blobId: staged.blobId, generation: 1 });
        expect(await store.completeBlobDelete(cleanup!.outboxId, "expired-bind-cleanup", now + 1)).toBe(true);
      } finally {
        await store.close();
      }
    });

    it("rolls back the item, event and ready transition when the final session update fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession("tenant_blob_rollback", "user_blob_rollback");
      const trigger = `blob_rollback_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      try {
        await store.createSession(session);
        const createdAtMs = Date.now();
        const staged = await stageAndUpload(store, session, createdAtMs, createdAtMs + 60_000);
        const item = toolResult(session, staged.blobId);
        await conn.query(
          `CREATE TRIGGER \`${trigger}\` BEFORE UPDATE ON sessions FOR EACH ROW
           BEGIN
             IF NEW.session_id = ? AND NEW.last_seq > OLD.last_seq THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected blob commit failure';
             END IF;
           END`,
          [session.id],
        );

        await expect(store.commit({
          sessionId: session.id,
          fence: 2,
          items: [item],
          blobBindings: [{ blobId: staged.blobId, itemId: item.id, purpose: "tool_output" }],
          events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: 151, item }],
        })).rejects.toThrow("injected blob commit failure");

        const rolledBack = await store.getBlobManifest(staged.blobId);
        expect(rolledBack).toMatchObject({
          state: "staging",
          stagingExpiresAtMs: staged.stagingExpiresAtMs,
        });
        expect(rolledBack?.itemId).toBeUndefined();
        expect(rolledBack?.readyAtMs).toBeUndefined();
        expect(await store.getItem(session.id, item.id)).toBeNull();
        expect(await store.readEvents(session.id, 0, 10)).toEqual([
          { type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 },
        ]);
        expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ lastSeq: 1, fenceToken: 1 });
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("rejects cross-session item, turn and approval identities before any projection can be overwritten", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const first = mkSession("tenant_identity_a", "user_identity_a");
      const second = mkSession("tenant_identity_b", "user_identity_b");
      try {
        await store.createSession(first);
        await store.createSession(second);
        const firstTurn = turn(first);
        const firstItem: Item = {
          id: newId("item"), sessionId: first.id, turnId: firstTurn.id, seq: 0, status: "completed",
          createdAtMs: 100, type: "agentMessage", text: "owner-a", phase: "finalAnswer",
        };
        const firstApproval = approval(first, firstTurn.id, firstItem.id);
        await store.commit({
          sessionId: first.id,
          fence: 1,
          turn: firstTurn,
          items: [firstItem],
          approvals: [firstApproval],
        });

        await expect(store.commit({
          sessionId: second.id,
          fence: 1,
          items: [{ ...firstItem, id: newId("item") }],
        })).rejects.toThrow("item does not belong to the committed session");
        await expect(store.commit({
          sessionId: second.id,
          fence: 1,
          turn: { ...firstTurn, sessionId: second.id },
        })).rejects.toThrow("turn identity conflicts with another session owner");
        await expect(store.commit({
          sessionId: second.id,
          fence: 1,
          items: [{ ...firstItem, sessionId: second.id, turnId: newId("turn"), text: "attacker" }],
        })).rejects.toThrow("item identity conflicts with another session owner");
        await expect(store.commit({
          sessionId: second.id,
          fence: 1,
          approvals: [{
            ...firstApproval,
            sessionId: second.id,
            turnId: newId("turn"),
            itemId: newId("item"),
            args: { overwritten: true },
          }],
        })).rejects.toThrow("approval identity conflicts with another session owner");
        await expect(store.commit({
          sessionId: first.id,
          fence: 2,
          events: [{
            type: "item/completed",
            sessionId: first.id,
            emittedAtMs: 200,
            item: { ...firstItem, turnId: newId("turn") },
          }],
        })).rejects.toThrow("item identity cannot change its turn or type");

        expect(await store.getTurn(first.id, firstTurn.id)).toMatchObject({ sessionId: first.id });
        expect(await store.getItem(first.id, firstItem.id)).toMatchObject({ sessionId: first.id, text: "owner-a" });
        expect(await store.getApproval(first.id, firstApproval.id)).toMatchObject({
          sessionId: first.id,
          args: {},
        });
        expect(await store.getTurn(second.id, firstTurn.id)).toBeNull();
        expect(await store.getItem(second.id, firstItem.id)).toBeNull();
        expect(await store.getApproval(second.id, firstApproval.id)).toBeNull();
        expect(await store.getSession(first.tenantId, first.id)).toMatchObject({ lastSeq: 1, fenceToken: 1 });
        expect(await store.getSession(second.tenantId, second.id)).toMatchObject({ lastSeq: 1, fenceToken: 0 });
      } finally {
        await store.close();
      }
    });

    it("allows only one concurrent first writer to own a globally keyed item", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const conn = await mysql.createConnection(mysqlUrl);
      const first = mkSession("tenant_concurrent_a", "user_concurrent_a");
      const second = mkSession("tenant_concurrent_b", "user_concurrent_b");
      const itemId = newId("item");
      try {
        await firstStore.createSession(first);
        await firstStore.createSession(second);
        const makeItem = (session: Session, text: string): Item => ({
          id: itemId,
          sessionId: session.id,
          turnId: newId("turn"),
          seq: 0,
          status: "completed",
          createdAtMs: 100,
          type: "agentMessage",
          text,
          phase: "finalAnswer",
        });
        const outcomes = await Promise.allSettled([
          firstStore.commit({ sessionId: first.id, fence: 1, items: [makeItem(first, "first")] }),
          secondStore.commit({ sessionId: second.id, fence: 1, items: [makeItem(second, "second")] }),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

        const [rows] = await conn.query<(RowDataPacket & { session_id: string; user_id: string; body: string })[]>(
          "SELECT session_id, user_id, body FROM items WHERE item_id=?",
          [itemId],
        );
        expect(rows).toHaveLength(1);
        const winningSession = rows[0]!.session_id === first.id ? first : second;
        const losingSession = winningSession.id === first.id ? second : first;
        expect(rows[0]).toMatchObject({ session_id: winningSession.id, user_id: winningSession.userId });
        const body = typeof rows[0]!.body === "string" ? JSON.parse(rows[0]!.body) : rows[0]!.body;
        expect(body).toMatchObject({
          sessionId: winningSession.id,
          text: winningSession.id === first.id ? "first" : "second",
        });
        expect(await firstStore.getSession(winningSession.tenantId, winningSession.id)).toMatchObject({ fenceToken: 1 });
        expect(await firstStore.getSession(losingSession.tenantId, losingSession.id)).toMatchObject({ fenceToken: 0 });
      } finally {
        await conn.end();
        await firstStore.close();
        await secondStore.close();
      }
    });

    it("leases, retries and completes stale staging deletion with CAS semantics", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const session = mkSession("tenant_blob_outbox", "user_blob_outbox");
      try {
        await store.createSession(session);
        const staged = await stageAndUpload(store, session, 100, 200);
        expect(await store.scheduleStaleBlobDeletes({ nowMs: 199, limit: 10 })).toBe(0);
        expect(await store.scheduleStaleBlobDeletes({ nowMs: 200, limit: 10 })).toBe(1);
        expect(await store.scheduleStaleBlobDeletes({ nowMs: 200, limit: 10 })).toBe(0);
        const pendingManifest = await store.getBlobManifest(staged.blobId);
        expect(pendingManifest).toMatchObject({
          state: "delete_pending",
          deletionGeneration: 1,
          deleteAfterMs: 200,
        });
        expect(pendingManifest?.stagingExpiresAtMs).toBeUndefined();

        const firstClaim = await store.claimBlobDeletes({
          nowMs: 200, limit: 10, leaseMs: 20, claimToken: "blob-worker-first",
        });
        expect(firstClaim).toHaveLength(1);
        expect(firstClaim[0]).toMatchObject({
          blobId: staged.blobId,
          generation: 1,
          storageBackend: staged.storageBackend,
          storageFormat: staged.storageFormat,
          storageKey: staged.storageKey,
          uploadToken: staged.uploadToken,
          attempts: 1,
          claimToken: "blob-worker-first",
          leaseUntilMs: 220,
        });
        expect(await store.claimBlobDeletes({
          nowMs: 219, limit: 10, leaseMs: 20, claimToken: "blob-worker-too-early",
        })).toEqual([]);
        expect(await store.retryBlobDelete(firstClaim[0]!.outboxId, "wrong-worker", {
          failedAtMs: 201,
          availableAtMs: 210,
          error: new Error("wrong worker"),
        })).toBe(false);
        expect(await store.retryBlobDelete(firstClaim[0]!.outboxId, "blob-worker-first", {
          failedAtMs: 201,
          availableAtMs: 210,
          error: new Error("file:///private/blob authorization=secret-value"),
        })).toBe(true);
        const retryState = await store.getBlobDeleteOutbox(staged.blobId, 1);
        expect(retryState).toMatchObject({ attempts: 1, availableAtMs: 210 });
        expect(retryState?.lastError).not.toContain("/private/blob");
        expect(retryState?.lastError).not.toContain("secret-value");

        const secondClaim = await store.claimBlobDeletes({
          nowMs: 210, limit: 10, leaseMs: 30, claimToken: "blob-worker-second",
        });
        expect(secondClaim[0]).toMatchObject({ attempts: 2, leaseUntilMs: 240 });
        expect(await store.completeBlobDelete(
          secondClaim[0]!.outboxId,
          "blob-worker-first",
          211,
        )).toBe(false);
        expect(await store.renewBlobDeleteClaim(
          secondClaim[0]!.outboxId,
          "blob-worker-second",
          { nowMs: 211, leaseMs: 40 },
        )).toBe(true);
        expect(await store.completeBlobDelete(
          secondClaim[0]!.outboxId,
          "blob-worker-second",
          212,
        )).toBe(true);
        expect(await store.completeBlobDelete(
          secondClaim[0]!.outboxId,
          "blob-worker-second",
          213,
        )).toBe(false);
        const deletedManifest = await store.getBlobManifest(staged.blobId);
        expect(deletedManifest).toMatchObject({
          state: "deleted",
          deletionGeneration: 1,
          deletedAtMs: 212,
        });
        expect(deletedManifest?.sha256).toBeUndefined();
        expect(deletedManifest?.sizeBytes).toBeUndefined();
        expect(deletedManifest?.contentType).toBeUndefined();
        expect(deletedManifest?.uploadedAtMs).toBeUndefined();
        const completedOutbox = await store.getBlobDeleteOutbox(staged.blobId, 1);
        expect(completedOutbox).toMatchObject({
          attempts: 2,
          completedAtMs: 212,
        });
        expect(completedOutbox?.claimToken).toBeUndefined();
        expect(completedOutbox?.leaseUntilMs).toBeUndefined();
        expect(await store.claimBlobDeletes({
          nowMs: 1_000, limit: 10, leaseMs: 20, claimToken: "blob-worker-after-complete",
        })).toEqual([]);
      } finally {
        await store.close();
      }
    });

    it("lets only one independent store claim an outbox and rejects completion after lease takeover", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const session = mkSession("tenant_blob_claim_race", "user_blob_claim_race");
      const now = Date.now();
      try {
        await firstStore.createSession(session);
        const staged = await stageAndUpload(firstStore, session, now - 60_000, now - 1_000);
        expect(await firstStore.scheduleStaleBlobDeletes({ nowMs: now, limit: 10 })).toBe(1);

        const claims = await Promise.all([
          firstStore.claimBlobDeletes({ nowMs: now, limit: 1, leaseMs: 50, claimToken: "claim-store-first" }),
          secondStore.claimBlobDeletes({ nowMs: now, limit: 1, leaseMs: 50, claimToken: "claim-store-second" }),
        ]);
        expect(claims.map((rows) => rows.length).sort()).toEqual([0, 1]);

        const winnerIndex = claims[0]!.length === 1 ? 0 : 1;
        const firstClaim = claims[winnerIndex]![0]!;
        const staleToken = firstClaim.claimToken!;
        const staleStore = winnerIndex === 0 ? firstStore : secondStore;
        const takeoverStore = winnerIndex === 0 ? secondStore : firstStore;

        const takeover = await takeoverStore.claimBlobDeletes({
          nowMs: now + 50,
          limit: 1,
          leaseMs: 100,
          claimToken: "claim-after-expiry",
        });
        expect(takeover).toHaveLength(1);
        expect(takeover[0]).toMatchObject({
          outboxId: firstClaim.outboxId,
          blobId: staged.blobId,
          generation: 1,
          attempts: 2,
          claimToken: "claim-after-expiry",
        });

        expect(await staleStore.completeBlobDelete(firstClaim.outboxId, staleToken, now + 51)).toBe(false);
        expect(await takeoverStore.completeBlobDelete(
          takeover[0]!.outboxId,
          "claim-after-expiry",
          now + 51,
        )).toBe(true);
        expect(await firstStore.getBlobManifest(staged.blobId)).toMatchObject({
          state: "deleted",
          deletionGeneration: 1,
          deletedAtMs: now + 51,
        });
      } finally {
        await firstStore.close();
        await secondStore.close();
      }
    });

    it("linearizes an expired staging sweep before a blocked bind and rolls the losing bind back", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const session = mkSession("tenant_blob_race", "user_blob_race");
      let sessionLocked = false;
      try {
        await store.createSession(session);
        const staged = await stageAndUpload(store, session, 100, 200);
        const item = toolResult(session, staged.blobId);

        await blocker.beginTransaction();
        await blocker.query("SELECT session_id FROM sessions WHERE session_id=? FOR UPDATE", [session.id]);
        sessionLocked = true;
        const bindOutcome = store.commit({
          sessionId: session.id,
          fence: 2,
          items: [item],
          blobBindings: [{ blobId: staged.blobId, itemId: item.id, purpose: "tool_output" }],
          events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: 151, item }],
        }).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );

        // The bind is waiting for the session lock and therefore cannot own the manifest row yet.
        // The sweeper may linearize first without ever taking a session lock.
        expect(await store.scheduleStaleBlobDeletes({ nowMs: 200, limit: 10 })).toBe(1);
        await blocker.commit();
        sessionLocked = false;

        const outcome = await bindOutcome;
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(BlobStateError);
        const swept = await store.getBlobManifest(staged.blobId);
        expect(swept).toMatchObject({
          state: "delete_pending",
          deletionGeneration: 1,
        });
        expect(swept?.itemId).toBeUndefined();
        expect(await store.getBlobDeleteOutbox(staged.blobId, 1)).toMatchObject({
          blobId: staged.blobId,
          generation: 1,
        });
        expect(await store.getItem(session.id, item.id)).toBeNull();
        expect(await store.readEvents(session.id, 0, 10)).toEqual([
          { type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 },
        ]);
        expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ lastSeq: 1, fenceToken: 1 });
      } finally {
        if (sessionLocked) await blocker.rollback().catch(() => {});
        await blocker.end();
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore blob lifecycle", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
