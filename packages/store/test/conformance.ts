import { describe, expect, it } from "vitest";
import type { Event, EventInput, Item, Session, Turn } from "@agent-service/protocol";
import { emptyUsage } from "@agent-service/protocol";
import { FenceError, SessionGoneError, type EventBus, type LeaseStore, type SessionStore } from "../src/index.js";

const v7 = () => {
  // test-only uuidv7-ish generator (time prefix + random), matches idSchema regex
  const t = Date.now().toString(16).padStart(12, "0");
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${r().slice(1)}-8${r().slice(1)}-${r()}${r()}${r()}`;
};
export const newId = (p: string) => `${p}_${v7()}`;

export const mkSession = (tenantId = "t_a", userId = "u_1"): Session => ({
  id: newId("sess"),
  tenantId,
  userId,
  agentId: newId("agt"),
  agentVersion: 1,
  status: { type: "idle" },
  lastSeq: 0,
  contextEpoch: "e0",
  fenceToken: 0,
  usage: emptyUsage(),
  autoApprovedTools: [],
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
  metadata: {},
});

export function sessionStoreConformance(name: string, make: () => Promise<SessionStore>) {
  describe(`SessionStore conformance: ${name}`, () => {
    it("assigns contiguous seqs across commits and rejects stale fences", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const ev = (type: "session/created"): EventInput => ({ type, sessionId: s.id, emittedAtMs: Date.now() });
      const r1 = await store.commit({ sessionId: s.id, fence: 1, events: [ev("session/created"), ev("session/created")] });
      expect(r1.events.map((e) => e.seq)).toEqual([1, 2]);
      const r2 = await store.commit({ sessionId: s.id, fence: 2, events: [ev("session/created")] });
      expect(r2.events[0]!.seq).toBe(3);
      await expect(store.commit({ sessionId: s.id, fence: 1, events: [ev("session/created")] })).rejects.toBeInstanceOf(FenceError);
      // same fence is allowed (same owner keeps writing)
      const r3 = await store.commit({ sessionId: s.id, fence: 2, events: [ev("session/created")] });
      expect(r3.events[0]!.seq).toBe(4);
      const all = await store.readEvents(s.id, 0, 100);
      expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect((await store.readEvents(s.id, 2, 100)).map((e) => e.seq)).toEqual([3, 4]);
      const got = await store.getSession(s.tenantId, s.id);
      expect(got?.lastSeq).toBe(4);
      expect(got?.fenceToken).toBe(2);
      await store.close();
    });

    it("isolates tenants: cross-tenant reads are indistinguishable from not-found", async () => {
      const store = await make();
      const s = mkSession("t_a");
      await store.createSession(s);
      expect(await store.getSession("t_b", s.id)).toBeNull();
      expect(await store.deleteSession("t_b", s.id)).toBe(false);
      expect((await store.listSessions("t_b", { limit: 10 })).data).toEqual([]);
      await store.close();
    });

    it("persists turns/items/approvals atomically with events and applies session patches", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const turn: Turn = {
        id: newId("turn"),
        sessionId: s.id,
        status: "inProgress",
        seqStart: 1,
        steps: 0,
        toolCalls: 0,
        usage: emptyUsage(),
        startedAtMs: Date.now(),
      };
      const itemId = newId("item");
      await store.commit({
        sessionId: s.id,
        fence: 1,
        turn,
        items: [{ id: itemId, sessionId: s.id, turnId: turn.id, seq: 1, status: "completed", createdAtMs: 1, type: "userMessage", content: [{ type: "text", text: "hi" }] }],
        events: [{ type: "turn/started", sessionId: s.id, emittedAtMs: 1, turn }],
        sessionPatch: { status: { type: "active", turnId: turn.id, activeFlags: [] }, title: "T" },
      });
      expect((await store.getTurn(s.id, turn.id))?.status).toBe("inProgress");
      expect((await store.listItems(s.id, { limit: 10 }))[0]?.id).toBe(itemId);
      const got = await store.getSession(s.tenantId, s.id);
      expect(got?.status.type).toBe("active");
      expect(got?.title).toBe("T");
      // upsert path
      await store.commit({ sessionId: s.id, fence: 1, turn: { ...turn, status: "completed", stopReason: "end_turn", completedAtMs: 2 } });
      expect((await store.getTurn(s.id, turn.id))?.status).toBe("completed");
      await store.close();
    });

    it("keeps an item's seq stable across upserts so incremental reads never skip it", async () => {
      // Regression: MySQL filtered/sorted on the `seq` column while returning `body`, so a second
      // upsert with a newer seq made the final message invisible to `listItems({afterSeq})`.
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const turnId = newId("turn");
      const itemId = newId("item");
      const started: Item = { id: itemId, sessionId: s.id, turnId, seq: 0, step: 1, status: "inProgress", createdAtMs: 1, type: "agentMessage", text: "", phase: "finalAnswer" };
      const r1 = await store.commit({
        sessionId: s.id, fence: 1, items: [started],
        events: [{ type: "item/started", sessionId: s.id, emittedAtMs: 1, item: started }],
      });
      const assigned = r1.events[0]!.seq;
      expect(started.seq).toBe(assigned);

      // a later commit completes the SAME item, after other events moved the watermark on
      const other: Item = { id: newId("item"), sessionId: s.id, turnId, seq: 0, step: 1, status: "completed", createdAtMs: 2, type: "reasoning", text: "think" };
      const completed: Item = { ...started, status: "completed", text: "final answer", completedAtMs: 3 };
      await store.commit({
        sessionId: s.id, fence: 1, items: [other, completed],
        events: [
          { type: "item/completed", sessionId: s.id, emittedAtMs: 2, item: other },
          { type: "item/completed", sessionId: s.id, emittedAtMs: 3, item: completed },
        ],
      });

      const all = await store.listItems(s.id, { limit: 100 });
      const back = all.find((i) => i.id === itemId)!;
      expect(back.seq).toBe(assigned);
      expect(back.type === "agentMessage" && back.text).toBe("final answer");
      // and an incremental read positioned just before it still returns it
      const incremental = await store.listItems(s.id, { afterSeq: assigned - 1, limit: 100 });
      expect(incremental.map((i) => i.id)).toContain(itemId);
      expect(all.map((i) => i.seq)).toEqual([...all.map((i) => i.seq)].sort((a, b) => a - b));
      await store.close();
    });

    it("newestFirst keeps the most recent items, not the oldest, and still returns them in seq order", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const turnId = newId("turn");
      for (let i = 0; i < 6; i++) {
        const item: Item = { id: newId("item"), sessionId: s.id, turnId, seq: 0, step: 1, status: "completed", createdAtMs: i, type: "agentMessage", text: `m${i}`, phase: "finalAnswer" };
        await store.commit({ sessionId: s.id, fence: 1, items: [item], events: [{ type: "item/completed", sessionId: s.id, emittedAtMs: i, item }] });
      }
      const oldest = await store.listItems(s.id, { limit: 2 });
      const newest = await store.listItems(s.id, { limit: 2, newestFirst: true });
      const text = (i: Item) => (i.type === "agentMessage" ? i.text : "");
      expect(oldest.map(text)).toEqual(["m0", "m1"]);
      expect(newest.map(text)).toEqual(["m4", "m5"]);
      expect(newest.map((i) => i.seq)).toEqual([...newest.map((i) => i.seq)].sort((a, b) => a - b));
      await store.close();
    });

    it("refuses writes to a deleted session and hides it from reads", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      expect(await store.deleteSession(s.tenantId, s.id)).toBe(true);
      expect(await store.getSession(s.tenantId, s.id)).toBeNull();
      expect(await store.deleteSession(s.tenantId, s.id)).toBe(false);
      await expect(store.commit({ sessionId: s.id, fence: 1, events: [{ type: "session/created", sessionId: s.id, emittedAtMs: 1 }] })).rejects.toBeInstanceOf(SessionGoneError);
      await store.close();
    });

    it("idempotency keys reserve once and replay after completion", async () => {
      const store = await make();
      const key = `k-${Math.random()}`;
      const a = { tenantId: "t_a", userId: "u_a", sessionId: "sess_a" };
      expect((await store.reserveIdempotencyKey(a, key, 60_000)).existing).toBeNull();
      expect((await store.reserveIdempotencyKey(a, key, 60_000)).existing).toEqual({ turnId: "", sessionId: "" });
      await store.completeIdempotencyKey(a, key, { turnId: "turn_x", sessionId: "sess_a" });
      expect((await store.reserveIdempotencyKey(a, key, 60_000)).existing).toEqual({ turnId: "turn_x", sessionId: "sess_a" });

      // The same opaque key is independent for another tenant, user, session, or case-distinct user.
      for (const scope of [
        { ...a, tenantId: "t_b" },
        { ...a, userId: "u_b" },
        { ...a, userId: "U_A" },
        { ...a, sessionId: "sess_b" },
      ]) {
        expect((await store.reserveIdempotencyKey(scope, key, 60_000)).existing).toBeNull();
      }
      // a failed request releases its reservation so the client may retry with the same key
      const k2 = `k2-${Math.random()}`;
      expect((await store.reserveIdempotencyKey(a, k2, 60_000)).existing).toBeNull();
      await store.releaseIdempotencyKey(a, k2);
      expect((await store.reserveIdempotencyKey(a, k2, 60_000)).existing).toBeNull();
      await store.close();
    });

    it("compares ownership and logical identifiers case-sensitively", async () => {
      const store = await make();
      const suffix = Math.random().toString(36).slice(2);
      const tenantUpper = `Tenant_${suffix}`;
      const tenantLower = tenantUpper.toLowerCase();
      const hashUpper = `hash-upper-${suffix}`.padEnd(64, "a").slice(0, 64);
      const hashLower = `hash-lower-${suffix}`.padEnd(64, "b").slice(0, 64);
      await store.createApiKey(tenantUpper, "KeyCase", hashUpper);
      await store.createApiKey(tenantLower, "keycase", hashLower);
      expect((await store.listApiKeys(tenantUpper)).map((k) => k.keyId)).toEqual(["KeyCase"]);
      expect((await store.listApiKeys(tenantLower)).map((k) => k.keyId)).toEqual(["keycase"]);
      expect(await store.revokeApiKey(tenantUpper, "keycase")).toBe(false);

      const session = mkSession(tenantUpper, "UserCase");
      const caseTwin = { ...mkSession(tenantUpper, "usercase"), id: session.id.toUpperCase() };
      await store.createSession(session);
      await store.createSession(caseTwin);
      expect((await store.listSessions(tenantUpper, { userId: "UserCase", limit: 10 })).data.map((s) => s.id)).toEqual([session.id]);
      expect((await store.listSessions(tenantUpper, { userId: "usercase", limit: 10 })).data.map((s) => s.id)).toEqual([caseTwin.id]);
      expect((await store.listSessions(tenantLower, { limit: 10 })).data).toEqual([]);

      const provider = {
        id: "ProviderCase", tenantId: tenantUpper, api: "openai-completions" as const, baseUrl: "https://x.example", headers: {},
        models: [{ id: "ModelCase", contextWindow: 1, maxOutputTokens: 1, input: ["text" as const], reasoning: false }],
        quota: {}, fallback: [], createdAtMs: 1, updatedAtMs: 1,
      };
      await store.upsertProviderConfig(provider);
      await store.upsertProviderConfig({ ...provider, id: "providercase", models: [{ ...provider.models[0]!, id: "modelcase" }] });
      expect((await store.listProviderConfigs(tenantUpper)).map((p) => p.id).sort()).toEqual(["ProviderCase", "providercase"].sort());
      expect(await store.getProviderConfig(tenantLower, "ProviderCase")).toBeNull();

      for (const [providerId, modelId, turnId] of [["ProviderCase", "ModelCase", "TurnCase"], ["providercase", "modelcase", "turncase"]] as const) {
        await store.appendUsage({
          tenantId: tenantUpper, userId: "UserCase", sessionId: session.id, turnId, step: 1,
          provider: providerId, model: modelId, usage: { ...emptyUsage(), totalTokens: 1 }, createdAtMs: Date.now(),
        });
      }
      expect((await store.queryUsage(tenantUpper, { userId: "usercase", groupBy: "total", limit: 100 })).data).toEqual([]);
      expect((await store.queryUsage(tenantUpper, { groupBy: "model", limit: 100 })).data.map((r) => r.key).sort()).toEqual([
        "ProviderCase/ModelCase", "providercase/modelcase",
      ].sort());
      expect((await store.queryUsage(tenantLower, { groupBy: "total", limit: 100 })).data).toEqual([]);
      await store.close();
    });

    it("stores provider configs with write-only secrets", async () => {
      const store = await make();
      const cfg = {
        id: "p1", tenantId: "t_a", api: "openai-completions" as const, baseUrl: "https://x.example", headers: {}, models: [{ id: "m", contextWindow: 1, maxOutputTokens: 1, input: ["text" as const], reasoning: false }],
        quota: {}, fallback: [], createdAtMs: 1, updatedAtMs: 1,
      };
      await store.upsertProviderConfig(cfg, { ciphertext: Buffer.from("cipher"), keyId: "k1" });
      const got = await store.getProviderConfig("t_a", "p1");
      expect(got?.secret?.ciphertext.toString()).toBe("cipher");
      await store.upsertProviderConfig({ ...cfg, name: "renamed" }); // no secret → keep old
      expect((await store.getProviderConfig("t_a", "p1"))?.secret?.keyId).toBe("k1");
      expect(await store.getProviderConfig("t_b", "p1")).toBeNull();
      await store.close();
    });
  });
}

export function leaseStoreConformance(name: string, make: () => Promise<LeaseStore>, expire: (l: LeaseStore, sid: string) => Promise<void>) {
  describe(`LeaseStore conformance: ${name}`, () => {
    it("single writer wins, fence increases on takeover, stale owner cannot renew", async () => {
      const lease = await make();
      const sid = newId("sess");
      const a = await lease.acquire(sid, "runner-a", "a:1", 60_000);
      expect(a.ok).toBe(true);
      const b = await lease.acquire(sid, "runner-b", "b:1", 60_000);
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.ownerId).toBe("runner-a");
      // re-acquire by the same owner keeps the fence
      const a2 = await lease.acquire(sid, "runner-a", "a:1", 60_000);
      expect(a2.ok && a2.fence).toBe(a.ok && a.fence);
      expect(await lease.renew(sid, "runner-a", 60_000)).toBe(true);
      await expire(lease, sid);
      const b2 = await lease.acquire(sid, "runner-b", "b:1", 60_000);
      expect(b2.ok).toBe(true);
      if (b2.ok && a.ok) expect(b2.fence).toBeGreaterThan(a.fence);
      expect(await lease.renew(sid, "runner-a", 60_000)).toBe(false);
      expect((await lease.getOwner(sid))?.ownerId).toBe("runner-b");
      await lease.release(sid, "runner-a"); // not owner → no-op
      expect((await lease.getOwner(sid))?.ownerId).toBe("runner-b");
      await lease.release(sid, "runner-b");
      expect(await lease.getOwner(sid)).toBeNull();
      await lease.close();
    });

    it("10 concurrent writers: exactly one acquires", async () => {
      const lease = await make();
      const sid = newId("sess");
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => lease.acquire(sid, `w-${i}`, `w:${i}`, 60_000)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      await lease.close();
    });
  });
}

export function eventBusConformance(name: string, make: () => Promise<EventBus>) {
  describe(`EventBus conformance: ${name}`, () => {
    it("delivers live events and replays persisted events after a seq without duplicates", async () => {
      const bus = await make();
      const sid = newId("sess");
      const pe = (seq: number): Event => ({ type: "session/created", sessionId: sid, emittedAtMs: seq, seq });
      const delta: Event = { type: "heartbeat", sessionId: sid, emittedAtMs: 0 };
      await bus.publish(sid, pe(1));
      await bus.publish(sid, pe(2));
      await bus.publish(sid, delta);
      const got: Event[] = [];
      const unsub = await bus.subscribe(sid, (e) => got.push(e), { afterSeq: 1 });
      await bus.publish(sid, pe(3));
      await bus.publish(sid, delta);
      await new Promise((r) => setTimeout(r, 100));
      const seqs = got.filter((e) => typeof (e as { seq?: number }).seq === "number").map((e) => (e as { seq: number }).seq);
      expect(seqs).toEqual([2, 3]);
      expect(got.filter((e) => e.type === "heartbeat")).toHaveLength(1);
      unsub();
      await bus.publish(sid, pe(4));
      await new Promise((r) => setTimeout(r, 50));
      expect(seqs).toEqual([2, 3]);
      await bus.close();
    });
  });
}
