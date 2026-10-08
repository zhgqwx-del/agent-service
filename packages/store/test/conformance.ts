import { describe, expect, it } from "vitest";
import type { Approval, Event, EventInput, Item, Session, Turn } from "@agent-service/protocol";
import { emptyUsage } from "@agent-service/protocol";
import {
  FenceError,
  IdempotencyMismatchError,
  IdempotencyReplayError,
  SessionArchivedError,
  SessionExistsError,
  SessionGoneError,
  SessionLifecycleBusyError,
  SessionVersionError,
  type EventBus,
  type LeaseStore,
  type SessionLifecycleTransition,
  type SessionStore,
} from "../src/index.js";

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
    it("atomically creates a session with exactly one seq-1 creation event", async () => {
      const store = await make();
      const s = mkSession("t_create", "u_create");
      const result = await store.createSession(s);

      expect(result).toEqual({
        events: [{ type: "session/created", sessionId: s.id, emittedAtMs: s.createdAtMs, seq: 1 }],
        lastSeq: 1,
      });
      expect(s.lastSeq).toBe(0); // persistence must not partially mutate the caller's object
      expect(await store.getSession(s.tenantId, s.id)).toMatchObject({
        id: s.id,
        tenantId: s.tenantId,
        userId: s.userId,
        lastSeq: 1,
        fenceToken: 0,
      });
      expect(await store.readEvents(s.id, 0, 10)).toEqual(result.events);
      await store.close();
    });

    it("leaves neither session nor event when session serialization fails", async () => {
      const store = await make();
      const metadata = {} as Record<string, unknown>;
      Object.defineProperty(metadata, "invalid", {
        enumerable: true,
        get: () => { throw new Error("injected session serialization failure"); },
      });
      const s = { ...mkSession(), metadata };

      await expect(store.createSession(s)).rejects.toThrow("injected session serialization failure");
      expect(await store.getSession(s.tenantId, s.id)).toBeNull();
      expect(await store.readEvents(s.id, 0, 10)).toEqual([]);
      await store.close();
    });

    it("rejects non-pristine session cursors before creating any state", async () => {
      const store = await make();
      const advanced = { ...mkSession(), lastSeq: 2 };
      const fenced = { ...mkSession(), fenceToken: 3 };

      await expect(store.createSession(advanced)).rejects.toThrow("lastSeq 0");
      await expect(store.createSession(fenced)).rejects.toThrow("fenceToken 0");
      for (const session of [advanced, fenced]) {
        expect(await store.getSession(session.tenantId, session.id)).toBeNull();
        expect(await store.readEvents(session.id, 0, 10)).toEqual([]);
      }
      await store.close();
    });

    it("serializes concurrent creators so one owner wins without tenant/user state mixing", async () => {
      const store = await make();
      const first = mkSession("tenant_a", "user_a");
      const second = { ...mkSession("tenant_b", "user_b"), id: first.id };
      const outcomes = await Promise.allSettled([store.createSession(first), store.createSession(second)]);
      const winner = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
      const loser = winner === 0 ? 1 : 0;

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes[loser]).toMatchObject({ status: "rejected", reason: expect.any(SessionExistsError) });
      const winningSession = [first, second][winner]!;
      const losingSession = [first, second][loser]!;
      expect(await store.getSession(winningSession.tenantId, first.id)).toMatchObject({
        tenantId: winningSession.tenantId,
        userId: winningSession.userId,
        lastSeq: 1,
      });
      expect(await store.getSession(losingSession.tenantId, first.id)).toBeNull();
      expect(await store.readEvents(first.id, 0, 10)).toEqual([
        { type: "session/created", sessionId: first.id, emittedAtMs: winningSession.createdAtMs, seq: 1 },
      ]);
      await store.close();
    });

    it("assigns contiguous seqs across commits and rejects stale fences", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const ev = (type: "session/created"): EventInput => ({ type, sessionId: s.id, emittedAtMs: Date.now() });
      const r1 = await store.commit({ sessionId: s.id, fence: 1, events: [ev("session/created"), ev("session/created")] });
      expect(r1.events.map((e) => e.seq)).toEqual([2, 3]);
      const r2 = await store.commit({ sessionId: s.id, fence: 2, events: [ev("session/created")] });
      expect(r2.events[0]!.seq).toBe(4);
      await expect(store.commit({ sessionId: s.id, fence: 1, events: [ev("session/created")] })).rejects.toBeInstanceOf(FenceError);
      // same fence is allowed (same owner keeps writing)
      const r3 = await store.commit({ sessionId: s.id, fence: 2, events: [ev("session/created")] });
      expect(r3.events[0]!.seq).toBe(5);
      const all = await store.readEvents(s.id, 0, 100);
      expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect((await store.readEvents(s.id, 2, 100)).map((e) => e.seq)).toEqual([3, 4, 5]);
      const got = await store.getSession(s.tenantId, s.id);
      expect(got?.lastSeq).toBe(5);
      expect(got?.fenceToken).toBe(2);
      await store.close();
    });

    it("sets and clears the archive marker atomically with lifecycle events", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const archivedAtMs = Date.now();

      const archived = await store.commit({
        sessionId: s.id,
        fence: 1,
        lifecycle: { type: "archive", atMs: archivedAtMs, tenantId: s.tenantId, userId: s.userId },
        events: [{ type: "session/archived", sessionId: s.id, emittedAtMs: archivedAtMs }],
      });
      expect(archived.events).toEqual([
        { type: "session/archived", sessionId: s.id, emittedAtMs: archivedAtMs, seq: 2 },
      ]);
      expect(await store.getSession(s.tenantId, s.id)).toMatchObject({ archivedAtMs, lastSeq: 2, fenceToken: 1 });
      expect((await store.listSessions(s.tenantId, { limit: 100 })).data.map((session) => session.id)).not.toContain(s.id);
      expect((await store.listSessions(s.tenantId, { limit: 100, includeArchived: true })).data.map((session) => session.id)).toContain(s.id);

      await expect(store.commit({
        sessionId: s.id,
        fence: 2,
        events: [{ type: "session/created", sessionId: s.id, emittedAtMs: archivedAtMs + 1 }],
        sessionPatch: { title: "must not change" },
      })).rejects.toBeInstanceOf(SessionArchivedError);
      expect(await store.getSession(s.tenantId, s.id)).toMatchObject({ archivedAtMs, lastSeq: 2, fenceToken: 1 });
      expect((await store.getSession(s.tenantId, s.id))?.title).toBeUndefined();

      const unarchivedAtMs = archivedAtMs + 1;
      const unarchived = await store.commit({
        sessionId: s.id,
        fence: 2,
        lifecycle: { type: "unarchive", atMs: unarchivedAtMs, tenantId: s.tenantId, userId: s.userId },
        events: [{ type: "session/unarchived", sessionId: s.id, emittedAtMs: unarchivedAtMs }],
      });
      expect(unarchived.events).toEqual([
        { type: "session/unarchived", sessionId: s.id, emittedAtMs: unarchivedAtMs, seq: 3 },
      ]);
      expect(await store.getSession(s.tenantId, s.id)).toMatchObject({ lastSeq: 3, fenceToken: 2 });
      expect((await store.getSession(s.tenantId, s.id))?.archivedAtMs).toBeUndefined();
      expect((await store.listSessions(s.tenantId, { limit: 100 })).data.map((session) => session.id)).toContain(s.id);
      await store.close();
    });

    it("rolls back the complete lifecycle batch when approval serialization fails", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      await store.commit({ sessionId: s.id, fence: 1, sessionPatch: { autoApprovedTools: ["danger"] } });
      const args = {} as Record<string, unknown>;
      Object.defineProperty(args, "invalid", {
        enumerable: true,
        get: () => { throw new Error("injected lifecycle serialization failure"); },
      });
      const approval: Approval = {
        id: newId("apr"), sessionId: s.id, turnId: newId("turn"), itemId: newId("item"),
        status: "expired", toolCallId: "call", toolName: "danger", args,
        availableDecisions: ["accept", "decline"], decision: "cancel", decidedBy: "system:archive",
        createdAtMs: 1, expiresAtMs: 2, resolvedAtMs: 3,
      };
      const archivedAtMs = Date.now();

      await expect(store.commit({
        sessionId: s.id,
        fence: 2,
        lifecycle: { type: "archive", atMs: archivedAtMs, tenantId: s.tenantId, userId: s.userId },
        approvals: [approval],
        events: [{ type: "session/archived", sessionId: s.id, emittedAtMs: archivedAtMs }],
        sessionPatch: { autoApprovedTools: [] },
      })).rejects.toThrow("injected lifecycle serialization failure");

      expect(await store.getSession(s.tenantId, s.id)).toMatchObject({
        lastSeq: 1,
        fenceToken: 1,
        autoApprovedTools: ["danger"],
      });
      expect((await store.getSession(s.tenantId, s.id))?.archivedAtMs).toBeUndefined();
      expect(await store.readEvents(s.id, 0, 10)).toHaveLength(1);
      expect(await store.getApproval(s.id, approval.id)).toBeNull();
      await store.close();
    });

    it("does not mutate memory state when lifecycle serialization itself fails", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const lifecycle = {
        type: "archive",
        tenantId: s.tenantId,
        userId: s.userId,
      } as unknown as SessionLifecycleTransition;
      Object.defineProperty(lifecycle, "atMs", {
        enumerable: true,
        get: () => { throw new Error("injected lifecycle marker serialization failure"); },
      });

      await expect(store.commit({
        sessionId: s.id,
        fence: 9,
        lifecycle,
        events: [{ type: "session/archived", sessionId: s.id, emittedAtMs: Date.now() }],
      })).rejects.toThrow("injected lifecycle marker serialization failure");
      const unchanged = await store.getSession(s.tenantId, s.id);
      expect(unchanged).toMatchObject({ lastSeq: 1, fenceToken: 0 });
      expect(unchanged?.archivedAtMs).toBeUndefined();
      expect((await store.readEvents(s.id, 0, 10)).map((event) => event.type)).toEqual(["session/created"]);
      await store.close();
    });

    it("enforces lifecycle ownership, fencing, active-session and tombstone guards", async () => {
      const store = await make();
      const s = mkSession("t_lifecycle_guards", "u_lifecycle_guards");
      await store.createSession(s);
      await store.commit({
        sessionId: s.id,
        fence: 2,
        sessionPatch: { status: { type: "active", turnId: newId("turn"), activeFlags: [] } },
      });
      const lifecycle = {
        type: "archive" as const,
        atMs: Date.now(),
        tenantId: s.tenantId,
        userId: s.userId,
      };

      await expect(store.commit({ sessionId: s.id, fence: 1, lifecycle })).rejects.toBeInstanceOf(FenceError);
      await expect(store.commit({
        sessionId: s.id,
        fence: 3,
        lifecycle: { ...lifecycle, userId: "u_wrong" },
      })).rejects.toBeInstanceOf(SessionGoneError);
      await expect(store.commit({ sessionId: s.id, fence: 3, lifecycle })).rejects.toBeInstanceOf(SessionLifecycleBusyError);
      const guardedSession = await store.getSession(s.tenantId, s.id);
      expect(guardedSession).toMatchObject({
        status: { type: "active" },
        fenceToken: 2,
        lastSeq: 1,
      });
      expect(guardedSession?.archivedAtMs).toBeUndefined();

      expect(await store.deleteSession(s.tenantId, s.id)).toBe(true);
      await expect(store.commit({
        sessionId: s.id,
        fence: 3,
        lifecycle: { ...lifecycle, type: "unarchive" },
      })).rejects.toBeInstanceOf(SessionGoneError);
      await store.close();
    });

    it("claims a durable fence without changing active or archived business state", async () => {
      const store = await make();
      const s = mkSession("t_fence_claim", "u_fence_claim");
      await store.createSession(s);
      const activeStatus = { type: "active" as const, turnId: newId("turn"), activeFlags: [] };
      await store.commit({ sessionId: s.id, fence: 1, sessionPatch: { status: activeStatus } });

      await expect(store.commit({
        sessionId: s.id,
        fence: 2,
        fenceClaim: { tenantId: s.tenantId, userId: "u_wrong" },
      })).rejects.toBeInstanceOf(SessionGoneError);
      await expect(store.commit({
        sessionId: s.id,
        fence: 2,
        fenceClaim: { tenantId: s.tenantId, userId: s.userId },
        sessionPatch: { status: { type: "idle" } },
      })).rejects.toThrow("fenceClaim must be a pure fence-only commit");

      const beforeActiveClaim = await store.getSession(s.tenantId, s.id);
      const claimedActive = await store.commit({
        sessionId: s.id,
        fence: 2,
        fenceClaim: { tenantId: s.tenantId, userId: s.userId },
      });
      expect(claimedActive).toEqual({ events: [], lastSeq: 1 });
      expect(await store.getSession(s.tenantId, s.id)).toMatchObject({ status: activeStatus, fenceToken: 2, lastSeq: 1 });
      expect((await store.getSession(s.tenantId, s.id))?.updatedAtMs).toBe(beforeActiveClaim?.updatedAtMs);

      const archivedAtMs = Date.now();
      await store.commit({
        sessionId: s.id,
        fence: 3,
        lifecycle: { type: "archive", atMs: archivedAtMs, tenantId: s.tenantId, userId: s.userId },
        events: [{ type: "session/archived", sessionId: s.id, emittedAtMs: archivedAtMs }],
        sessionPatch: { status: { type: "idle" } },
      });
      const beforeArchivedClaim = await store.getSession(s.tenantId, s.id);
      const claimedArchived = await store.commit({
        sessionId: s.id,
        fence: 4,
        fenceClaim: { tenantId: s.tenantId, userId: s.userId },
      });
      expect(claimedArchived).toEqual({ events: [], lastSeq: 2 });
      expect(await store.getSession(s.tenantId, s.id)).toMatchObject({ archivedAtMs, status: { type: "idle" }, fenceToken: 4, lastSeq: 2 });
      expect((await store.getSession(s.tenantId, s.id))?.updatedAtMs).toBe(beforeArchivedClaim?.updatedAtMs);
      await expect(store.commit({
        sessionId: s.id,
        fence: 3,
        sessionPatch: { title: "stale writer" },
      })).rejects.toBeInstanceOf(FenceError);
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

    it("rejects a snapshot-derived batch when the session event surface changed", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      await expect(store.commit({
        sessionId: s.id,
        fence: 1,
        expectedLastSeq: 0,
        events: [{ type: "session/created", sessionId: s.id, emittedAtMs: 2 }],
        sessionPatch: { title: "stale" },
      })).rejects.toBeInstanceOf(SessionVersionError);
      expect(await store.readEvents(s.id, 0, 10)).toHaveLength(1);
      expect((await store.getSession(s.tenantId, s.id))?.title).toBeUndefined();
      await store.close();
    });

    it("leaves no partial state when a batch payload cannot be serialized", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const details = {} as Record<string, unknown>;
      Object.defineProperty(details, "invalid", {
        enumerable: true,
        get: () => { throw new Error("injected serialization failure"); },
      });
      const turn: Turn = {
        id: newId("turn"), sessionId: s.id, status: "completed", seqStart: 2,
        steps: 0, toolCalls: 0, usage: emptyUsage(), startedAtMs: 1,
        completedAtMs: 2, stopReason: "end_turn",
      };
      const item: Item = {
        id: newId("item"), sessionId: s.id, turnId: turn.id, seq: 0,
        status: "completed", createdAtMs: 1, completedAtMs: 1, type: "toolResult",
        toolCallId: "call-1", name: "broken", content: [], isError: false, details,
      };
      const scope = { tenantId: s.tenantId, userId: s.userId, sessionId: s.id };
      const idemKey = `bad-${Math.random()}`;

      const events: EventInput[] = [
        { type: "session/created", sessionId: s.id, emittedAtMs: 1 },
        { type: "item/completed", sessionId: s.id, emittedAtMs: 2, item },
        { type: "turn/completed", sessionId: s.id, emittedAtMs: 2, turn, stopReason: "end_turn" },
      ];
      await expect(store.commit({
        sessionId: s.id,
        fence: 7,
        turn,
        items: [item],
        usageEntries: [{ turnId: turn.id, step: 1, provider: "p", model: "m", usage: emptyUsage(), createdAtMs: 1 }],
        idempotency: {
          scope, key: idemKey, requestHash: "a".repeat(64),
          value: { turnId: turn.id, sessionId: s.id }, expiresAtMs: Date.now() + 60_000,
        },
        events,
        sessionPatch: { title: "must roll back" },
      })).rejects.toThrow("injected serialization failure");

      expect(item.seq).toBe(0);
      expect(turn.seqEnd).toBeUndefined();
      expect((events[1] as Extract<EventInput, { type: "item/completed" }>).item.seq).toBe(0);
      expect((events[2] as Extract<EventInput, { type: "turn/completed" }>).turn.seqEnd).toBeUndefined();
      expect(await store.getSession(s.tenantId, s.id)).toMatchObject({ lastSeq: 1, fenceToken: 0 });
      expect((await store.getSession(s.tenantId, s.id))?.title).toBeUndefined();
      expect(await store.readEvents(s.id, 0, 10)).toEqual([
        { type: "session/created", sessionId: s.id, emittedAtMs: s.createdAtMs, seq: 1 },
      ]);
      expect(await store.getItem(s.id, item.id)).toBeNull();
      expect(await store.getTurn(s.id, turn.id)).toBeNull();
      expect((await store.queryUsage(s.tenantId, { sessionId: s.id, groupBy: "total", limit: 10 })).data).toEqual([]);
      expect(await store.getIdempotencyKey(scope, idemKey)).toBeNull();
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
        seqStart: 2,
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
        items: [{ id: itemId, sessionId: s.id, turnId: turn.id, seq: 0, status: "completed", createdAtMs: 1, type: "userMessage", content: [{ type: "text", text: "hi" }] }],
        events: [{ type: "turn/started", sessionId: s.id, emittedAtMs: 1, turn }],
        sessionPatch: { status: { type: "active", turnId: turn.id, activeFlags: [] }, title: "T" },
      });
      expect((await store.getTurn(s.id, turn.id))?.status).toBe("inProgress");
      expect((await store.listItems(s.id, { limit: 10 }))[0]?.id).toBe(itemId);
      const got = await store.getSession(s.tenantId, s.id);
      expect(got?.status.type).toBe("active");
      expect(got?.title).toBe("T");
      // upsert path: the store assigns seqEnd inside the same transaction as turn/completed.
      const completed: Turn = { ...turn, status: "completed", stopReason: "end_turn", completedAtMs: 2 };
      const completedEvent: EventInput = { type: "turn/completed", sessionId: s.id, emittedAtMs: 2, turn: completed, stopReason: "end_turn" };
      const ended = await store.commit({
        sessionId: s.id,
        fence: 1,
        turn: completed,
        events: [completedEvent],
      });
      expect(completed.seqEnd).toBe(ended.lastSeq);
      expect((completedEvent as Extract<EventInput, { type: "turn/completed" }>).turn.seqEnd).toBe(ended.lastSeq);
      expect(await store.getTurn(s.id, turn.id)).toMatchObject({ status: "completed", seqEnd: ended.lastSeq });
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

    it("commits idempotency receipts atomically with turn creation and rejects replay/mismatch without side effects", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const key = `k-${Math.random()}`;
      const scope = { tenantId: s.tenantId, userId: s.userId, sessionId: s.id };
      const hash = "a".repeat(64);
      const turn: Turn = {
        id: newId("turn"), sessionId: s.id, status: "inProgress", seqStart: 2,
        steps: 0, toolCalls: 0, usage: emptyUsage(), startedAtMs: Date.now(), idempotencyKey: key,
      };
      await store.commit({
        sessionId: s.id,
        fence: 1,
        turn,
        events: [{ type: "turn/started", sessionId: s.id, emittedAtMs: 1, turn }],
        idempotency: { scope, key, requestHash: hash, value: { turnId: turn.id, sessionId: s.id }, expiresAtMs: Date.now() + 60_000 },
      });
      expect(await store.getIdempotencyKey(scope, key)).toMatchObject({ requestHash: hash, value: { turnId: turn.id, sessionId: s.id } });

      const duplicate: Turn = { ...turn, id: newId("turn"), seqStart: 3 };
      await expect(store.commit({
        sessionId: s.id,
        fence: 2,
        turn: duplicate,
        events: [{ type: "turn/started", sessionId: s.id, emittedAtMs: 2, turn: duplicate }],
        sessionPatch: { title: "must roll back" },
        idempotency: { scope, key, requestHash: hash, value: { turnId: duplicate.id, sessionId: s.id }, expiresAtMs: Date.now() + 60_000 },
      })).rejects.toBeInstanceOf(IdempotencyReplayError);
      expect(await store.getTurn(s.id, duplicate.id)).toBeNull();
      expect((await store.getSession(s.tenantId, s.id))?.title).toBeUndefined();
      expect(await store.readEvents(s.id, 0, 100)).toHaveLength(2);

      await expect(store.commit({
        sessionId: s.id,
        fence: 2,
        idempotency: { scope, key, requestHash: "b".repeat(64), value: { turnId: duplicate.id, sessionId: s.id }, expiresAtMs: Date.now() + 60_000 },
      })).rejects.toBeInstanceOf(IdempotencyMismatchError);
      await store.close();
    });

    it("commits usage with its event/projection and rolls the whole batch back on a duplicate", async () => {
      const store = await make();
      const s = mkSession();
      await store.createSession(s);
      const turnId = newId("turn");
      const usage = { ...emptyUsage(), inputTokens: 3, outputTokens: 2, totalTokens: 5 };
      await store.commit({
        sessionId: s.id,
        fence: 1,
        events: [{ type: "session/created", sessionId: s.id, emittedAtMs: 1 }],
        usageEntries: [{ turnId, step: 1, provider: "p", model: "m", usage, createdAtMs: 1 }],
        sessionPatch: { title: "committed", usage },
      });
      expect((await store.queryUsage(s.tenantId, { sessionId: s.id, groupBy: "total", limit: 10 })).data[0]).toMatchObject({ steps: 1, usage: { totalTokens: 5 } });

      await expect(store.commit({
        sessionId: s.id,
        fence: 2,
        events: [{ type: "session/created", sessionId: s.id, emittedAtMs: 2 }],
        usageEntries: [{ turnId, step: 1, provider: "p", model: "m", usage, createdAtMs: 2 }],
        sessionPatch: { title: "must roll back", usage: { ...usage, totalTokens: 10 } },
      })).rejects.toThrow();

      const after = await store.getSession(s.tenantId, s.id);
      expect(after).toMatchObject({ title: "committed", lastSeq: 2, fenceToken: 1, usage: { totalTokens: 5 } });
      expect(await store.readEvents(s.id, 0, 100)).toHaveLength(2);
      expect((await store.queryUsage(s.tenantId, { sessionId: s.id, groupBy: "total", limit: 10 })).data[0]).toMatchObject({ steps: 1, usage: { totalTokens: 5 } });

      await expect(store.commit({
        sessionId: s.id,
        fence: 0,
        usageEntries: [{ turnId: newId("turn"), step: 1, provider: "p", model: "m", usage, createdAtMs: 3 }],
      })).rejects.toBeInstanceOf(FenceError);
      expect((await store.queryUsage(s.tenantId, { sessionId: s.id, groupBy: "total", limit: 10 })).data[0]?.steps).toBe(1);
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
        await store.commit({
          sessionId: session.id,
          fence: 1,
          usageEntries: [{ turnId, step: 1, provider: providerId, model: modelId, usage: { ...emptyUsage(), totalTokens: 1 }, createdAtMs: Date.now() }],
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
