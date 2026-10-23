import { describe, expect, it, vi } from "vitest";
import type { Pool } from "mysql2/promise";
import { MemorySessionStore, MysqlSessionStore, attachSessionWriteAdmission, createSessionAcquireCommand, BLOB_STORAGE_FORMAT } from "../src/index.js";
import { MysqlSessionAuthority, ownSessionAuthorityMysqlTransport, type MysqlSessionAuthorityPort } from "../src/mysql/session-authority.js";
import { randomUUID } from "node:crypto";
import { mkSession, newId } from "./conformance.js";

// Pure boundary tests: no native database, network or counterfeit SQL success is claimed.
describe("session authority entry and transaction ownership", () => {
  for (const name of ["commit", "stageBlob", "markBlobUploaded"] as const) {
    it(`rejects current-schema ${name} before borrowing when admission is attached after invocation`, async () => {
      const memory = new MemorySessionStore(), session = mkSession(); await memory.createSession(session);
      const owner = { tenantId: session.tenantId, userId: session.userId };
      const grant = await memory.sessionAuthority.acquire(createSessionAcquireCommand({ sessionId: session.id, principal: owner,
        runnerId: "boundary-fixture", runnerAddr: "http://127.0.0.1:10001", bootId: randomUUID(), acquisitionId: randomUUID(), expectedFence: 0, ttlMs: 1000 }));
      if (!grant.ok) throw Error("fixture authority unavailable");
      const borrow = vi.fn(async () => { throw Error("unadmitted entry borrowed a connection"); }), end = vi.fn(async () => {});
      const sqlStore = Reflect.construct(MysqlSessionStore, [{ getConnection: borrow, end }]) as MysqlSessionStore;
      Reflect.set(sqlStore, "sessionAuthoritySchemaInstalled", true);
      const blobId = newId("blob");
      try {
        const call = (() => {
          if (name === "commit") { const body = { sessionId: session.id, fence: grant.fence, events: [] };
            return { body, pending: sqlStore.commit(body) }; }
          if (name === "stageBlob") { const body = { owner, sessionId: session.id, fence: grant.fence, blobId,
            purpose: "tool_output" as const, storageBackend: "memory-v1", storageFormat: BLOB_STORAGE_FORMAT,
            storageKey: `objects/${blobId.slice(5)}`, uploadToken: "fixture-upload-token", createdAtMs: 1, stagingExpiresAtMs: 1001 };
            return { body, pending: sqlStore.stageBlob(body) }; }
          const body = { owner, sessionId: session.id, fence: grant.fence, blobId, uploadToken: "fixture-upload-token",
            sha256: "a".repeat(64), sizeBytes: 42, contentType: "application/json", uploadedAtMs: 2 };
          return { body, pending: sqlStore.markBlobUploaded(body) };
        })();
        attachSessionWriteAdmission(call.body, grant.proof);
        await expect(call.pending).rejects.toMatchObject({ code: "session_authority_unavailable" });
        expect(borrow).not.toHaveBeenCalled();
      } finally { await sqlStore.close(); await memory.close(); }
      expect(end).toHaveBeenCalledOnce();
    });
  }

  it("keeps the true pre-0066 connection path without requiring a new proof", async () => {
    const sentinel = Error("historical connection boundary"), borrow = vi.fn(async () => { throw sentinel; }), end = vi.fn(async () => {});
    const store = Reflect.construct(MysqlSessionStore, [{ getConnection: borrow, end }]) as MysqlSessionStore;
    try {
      await expect(store.commit({ sessionId: mkSession().id, fence: 1, events: [] })).rejects.toBe(sentinel);
      expect(borrow).toHaveBeenCalledOnce();
    } finally { await store.close(); }
    expect(end).toHaveBeenCalledOnce();
  });

  it("owns default pool close once without retaining an unused abort connection registry", async () => {
    const order: string[] = [], end = vi.fn(async () => { order.push("end"); }), on = vi.fn();
    const transport = { close: vi.fn(() => { order.push("transport-close"); }) };
    const owner = ownSessionAuthorityMysqlTransport({ end, on } as unknown as Pool, transport);
    const first = owner.close(); expect(owner.close()).toBe(first); await first;
    expect(on).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledOnce(); expect(transport.close).toHaveBeenCalledOnce();
    expect(order).toEqual(["end", "transport-close"]);
  });

  it("closes default transport after pool end rejects without replacing its undefined first error", async () => {
    const order: string[] = [], end = vi.fn(async () => { order.push("end"); throw undefined; });
    const transport = { close: vi.fn(() => { order.push("transport-close"); throw Error("secondary transport failure"); }) };
    const owner = ownSessionAuthorityMysqlTransport({ end } as unknown as Pool, transport);
    const pending = owner.close(); await expect(pending).rejects.toBeUndefined();
    expect(owner.close()).toBe(pending); expect(end).toHaveBeenCalledOnce(); expect(transport.close).toHaveBeenCalledOnce();
    expect(order).toEqual(["end", "transport-close"]);
  });

  for (const rollbackFails of [false, true]) {
    it(`keeps the original undefined failure and ${rollbackFails ? "destroys without releasing" : "releases only after a fulfilled rollback"}`, async () => {
      const order: string[] = [], conn = {
        query: vi.fn(async () => { order.push("query"); return [[]]; }),
        beginTransaction: vi.fn(async () => { order.push("begin"); }),
        commit: vi.fn(async () => { order.push("commit"); }),
        rollback: vi.fn(async () => { order.push("rollback"); if (rollbackFails) throw Error("rollback was not executed"); }),
        release: vi.fn(() => { order.push("release"); }),
        destroy: vi.fn(() => { order.push("destroy"); throw Error("secondary destroy failure"); }),
      };
      const pool = { getConnection: vi.fn(async () => conn) };
      const port: MysqlSessionAuthorityPort = {
        binding: async () => { throw undefined; }, gate: async () => {}, erasureGate: async () => {}, handoff: async (_c, _s, _f, write) => write(), expiryMutation: async (_c, _s, _f, write) => write(),
      };
      const authority = new MysqlSessionAuthority(pool as unknown as Pool, port);
      try {
        await expect(authority.getOwner(mkSession().id)).rejects.toBeUndefined();
        expect(conn.rollback).toHaveBeenCalledOnce(); expect(conn.commit).not.toHaveBeenCalled();
        if (rollbackFails) { expect(conn.destroy).toHaveBeenCalledOnce(); expect(conn.release).not.toHaveBeenCalled(); expect(order.at(-1)).toBe("destroy"); }
        else { expect(conn.destroy).not.toHaveBeenCalled(); expect(conn.release).toHaveBeenCalledOnce(); expect(order.slice(-2)).toEqual(["rollback", "release"]); }
      } finally { await authority.close(); }
    });
  }
});
