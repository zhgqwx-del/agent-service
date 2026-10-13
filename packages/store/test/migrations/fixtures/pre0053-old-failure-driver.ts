import { randomUUID } from "node:crypto";
import { emptyUsage, type Item, type Session, type Turn } from "@agent-service/protocol";
import { MysqlSessionStore, newUsageId } from "@agent-service/store";

// Copied into the published 0052 archive. All imported workspace packages are isolated frozen code.
const SOURCE_COMMIT = "5d669cf4e7aa71543b01a3eeebb90add77d0c934";
const url = process.env.MYSQL_URL;
if (!url) throw new Error("frozen 0052 failure driver requires MYSQL_URL");
const id = (kind: string) => {
  const time = Date.now().toString(16).padStart(12, "0");
  const random = randomUUID();
  return `${kind}_${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
};
const at = Date.now();
const tenantId = `tenant-frozen0052-${randomUUID()}`;
const userId = `user-frozen0052-${randomUUID()}`;
const session: Session = { id: id("sess"), tenantId, userId, agentId: id("agt"), agentVersion: 1,
  status: { type: "idle" }, lastSeq: 0, contextEpoch: "e0", fenceToken: 0, usage: emptyUsage(),
  autoApprovedTools: [], createdAtMs: at, updatedAtMs: at, metadata: {} };
const turn: Turn = { id: id("turn"), sessionId: session.id, status: "inProgress", seqStart: 2,
  steps: 1, toolCalls: 0, usage: emptyUsage(), startedAtMs: at, metadata: {} };
const item: Item = { id: id("item"), sessionId: session.id, turnId: turn.id, seq: 0, step: 1,
  type: "agentMessage", status: "failed", createdAtMs: at, completedAtMs: at,
  text: "historical failed-step content", phase: "finalAnswer" };
const usage = { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 };
const store = await MysqlSessionStore.connect({ url });
try {
  await store.createSession(session);
  await store.commit({ sessionId: session.id, fence: 1, turn,
    events: [{ type: "turn/started", sessionId: session.id, emittedAtMs: at, turn }],
    sessionPatch: { status: { type: "active", turnId: turn.id, activeFlags: [] } } });
  const result = await store.commit({ sessionId: session.id, fence: 1, expectedLastSeq: 2,
    turn: { ...turn, usage }, items: [item],
    events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: at, item },
      { type: "usage/updated", sessionId: session.id, emittedAtMs: at, turnId: turn.id, step: 1,
        stepUsage: usage, turnUsage: usage, sessionUsage: usage, runtime: { provider: "frozen-unit", model: "frozen-unit" } }],
    usageEntries: [{ usageId: newUsageId(), turnId: turn.id, step: 1, provider: "frozen-unit", model: "frozen-unit", usage, createdAtMs: at }],
    sessionPatch: { usage } });
  if (result.lastSeq !== 4) throw new Error("frozen 0052 failed-step cursor differed");
  process.stdout.write(JSON.stringify({ sourceCommit: SOURCE_COMMIT, tenantId, userId,
    sessionId: session.id, turnId: turn.id, itemId: item.id, lastSeq: result.lastSeq }));
} finally { await store.close(); }
