import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SessionHost } from "../../../packages/core/src/session/host.js";
import type { SessionStore } from "../../../packages/store/src/types.js";
import type { CommitReceipt, FakeRecordService, SavedDrink } from "./record-fixtures.js";

type RecordReader = Pick<FakeRecordService, "lookupReceipt" | "readRecord">;
type Owner = Parameters<RecordReader["lookupReceipt"]>[0];
type FeedbackContext = { requested: boolean; bottleCapacityMl?: number };
type FeedbackInput =
  | { trigger: "requested"; record: SavedDrink }
  | { trigger: "useful"; record: SavedDrink; bottle: { capacityMl: number; percent: number } };
type Trigger = FeedbackInput["trigger"];
type FeedbackKey = [tenantId: string, ownerId: string, operationId: string, recordVersion: number];
type TurnBinding = { sessionId: string | null; turnId: string | null };
type FeedbackView =
  | { status: "not_started" | "skipped" }
  | ({ status: "pending" | "failed"; trigger: Trigger } & TurnBinding)
  | { status: "completed"; trigger: Trigger; sessionId: string; turnId: string; itemId: string; text: string };
type FeedbackResult = { receipt: CommitReceipt; feedback: FeedbackView };
type FeedbackRow = {
  status: "skipped" | "pending" | "failed" | "completed";
  trigger: Trigger | null;
  session_id: string | null;
  turn_id: string | null;
  turn_key: string | null;
  item_id: string | null;
  answer: string | null;
};
type Observation = { status: "pending" | "failed" } | { status: "completed"; itemId: string; text: string };
type SubmittedTurn = { turnId: string; cancel(): Promise<void> };
type StartFeedback<T> = (owner: Owner, sessionId: string, input: string, idempotencyKey: string) => Promise<T>;
export type FeedbackRuntime = {
  observe(owner: Owner, sessionId: string, turnId: string): Promise<Observation>;
} & ({
  reserve: StartFeedback<SubmittedTurn & { run(): void }>;
} | {
  submit: StartFeedback<SubmittedTurn>;
  findSubmittedTurn(owner: Owner, sessionId: string, idempotencyKey: string): Promise<string | null>;
});

export function createHostFeedbackRuntime(
  host: Pick<SessionHost, "getSession" | "beginTurn" | "interrupt">,
  store: Pick<SessionStore, "getTurn" | "listItems">,
): FeedbackRuntime {
  return {
    async reserve(owner, sessionId, input, idempotencyKey) {
      const principal = { tenantId: owner.tenantId, userId: owner.ownerId };
      await host.getSession(principal, sessionId);
      const history = await store.listItems(sessionId, { limit: 1 });
      if (history.length) throw new Error("A feedback fixture needs an empty session");
      const begun = await host.beginTurn(principal, sessionId, {
        input: [{ type: "text", text: input }],
        busyPolicy: "reject",
        stream: false,
        metadata: {},
      }, { idempotencyKey });
      return {
        turnId: begun.turn.id,
        run: begun.run,
        async cancel() { await host.interrupt(principal, sessionId, begun.turn.id); },
      };
    },
    async observe(owner, sessionId, turnId) {
      await host.getSession({ tenantId: owner.tenantId, userId: owner.ownerId }, sessionId);
      const turn = await store.getTurn(sessionId, turnId);
      if (!turn || turn.status === "inProgress") return { status: "pending" };
      if (turn.status !== "completed" || turn.stopReason !== "end_turn") return { status: "failed" };
      const items = await store.listItems(sessionId, { turnId, limit: 200 });
      const final = items.findLast((item) => item.type === "agentMessage" && item.status === "completed"
        && item.phase === "finalAnswer" && item.sessionId === sessionId && item.turnId === turnId && item.text.trim());
      return final?.type === "agentMessage"
        ? { status: "completed", itemId: final.id, text: final.text }
        : { status: "pending" };
    },
  };
}

function selectFeedback(record: SavedDrink, context: FeedbackContext): FeedbackInput | null {
  if (context.requested) return { trigger: "requested", record };
  const amount = Number(record.value);
  const capacityMl = context.bottleCapacityMl;
  if (capacityMl === undefined || !Number.isFinite(capacityMl) || !Number.isFinite(amount)
    || amount <= 0 || capacityMl < amount) return null;
  return { trigger: "useful", record, bottle: { capacityMl, percent: Math.round((amount / capacityMl) * 10_000) / 100 } };
}

function view(row: FeedbackRow | undefined): FeedbackView {
  if (!row) return { status: "not_started" };
  if (row.status === "skipped") return { status: "skipped" };
  const trigger = row.trigger!;
  if (row.status === "completed") return {
    status: "completed", trigger, sessionId: row.session_id!, turnId: row.turn_id!, itemId: row.item_id!, text: row.answer!,
  };
  return { status: row.status, trigger, sessionId: row.session_id, turnId: row.turn_id };
}

/** The product receipt is authoritative. This fixture owns only the optional feedback decision and publication. */
export class RecordFeedback {
  #db: DatabaseSync;
  #records: RecordReader;
  #runtime: FeedbackRuntime;

  constructor(path: string, records: RecordReader, runtime: FeedbackRuntime) {
    this.#records = records;
    this.#runtime = runtime;
    this.#db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS feedback (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        record_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('skipped', 'pending', 'failed', 'completed')),
        trigger TEXT CHECK (trigger IN ('requested', 'useful')),
        input_json TEXT,
        turn_key TEXT,
        session_id TEXT UNIQUE,
        turn_id TEXT,
        item_id TEXT,
        answer TEXT,
        PRIMARY KEY (tenant_id, owner_id, operation_id, record_version),
        CHECK ((status = 'skipped') = (trigger IS NULL)),
        CHECK ((status = 'completed') = (item_id IS NOT NULL AND answer IS NOT NULL))
      )`);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #key(owner: Owner, receipt: CommitReceipt): FeedbackKey {
    return [owner.tenantId, owner.ownerId, receipt.operationId, receipt.recordVersion];
  }

  #lookup(key: FeedbackKey): FeedbackRow | undefined {
    return this.#db.prepare(`SELECT status, trigger, session_id, turn_id, turn_key, item_id, answer FROM feedback
      WHERE tenant_id = ? AND owner_id = ? AND operation_id = ? AND record_version = ?`).get(...key) as FeedbackRow | undefined;
  }

  #bindTurn(key: FeedbackKey, turnId: string): boolean {
    const bound = this.#db.prepare(`UPDATE feedback SET turn_id = ?
      WHERE tenant_id = ? AND owner_id = ? AND operation_id = ? AND record_version = ?
      AND status = 'pending' AND turn_id IS NULL`).run(turnId, ...key);
    // The original HTTP response and a concurrent read may confirm the same turn.
    return bound.changes === 1 || this.#lookup(key)?.turn_id === turnId;
  }

  async start(owner: Owner, clientOperationId: string, context: FeedbackContext, sessionId?: string): Promise<FeedbackResult | null> {
    const receipt = this.#records.lookupReceipt(owner, clientOperationId);
    if (!receipt) return null;
    const key = this.#key(owner, receipt);
    if (this.#lookup(key)) return this.read(owner, clientOperationId);
    const record = this.#records.readRecord(owner, receipt.recordId);
    if (!record || record.recordId !== receipt.recordId || record.recordVersion !== receipt.recordVersion) {
      return { receipt, feedback: { status: "not_started" } };
    }

    const input = selectFeedback(record, context);
    const inputJson = input ? JSON.stringify(input) : null;
    const turnKey = input ? "record-feedback-" + createHash("sha256").update(JSON.stringify(key)).digest("hex") : null;
    // Claim dispatch up front. A dedicated session keeps feedback tied to this record alone.
    const claimed = this.#db.prepare(`INSERT INTO feedback
      (tenant_id, owner_id, operation_id, record_version, status, trigger, input_json, turn_key, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(...key, input ? "pending" : "skipped", input?.trigger ?? null, inputJson, turnKey, input ? sessionId ?? null : null);
    if (claimed.changes === 0) return this.read(owner, clientOperationId);
    if (inputJson === null || turnKey === null || !sessionId) return { receipt, feedback: view(this.#lookup(key)) };

    const runtime = this.#runtime;
    let submitted: SubmittedTurn & { run?(): void };
    try {
      // The public HTTP route dispatches before returning the turn ID. Keep the prior claim
      // if that response is lost, so a later read cannot start another turn.
      submitted = "submit" in runtime ? await runtime.submit(owner, sessionId, inputJson, turnKey)
        : await runtime.reserve(owner, sessionId, inputJson, turnKey);
    } catch {
      return { receipt, feedback: view(this.#lookup(key)) };
    }
    try {
      if (!this.#bindTurn(key, submitted.turnId)) throw new Error("Feedback turn binding did not persist");
    } catch {
      await submitted.cancel().catch(() => {});
      return { receipt, feedback: view(this.#lookup(key)) };
    }
    submitted.run?.();
    return { receipt, feedback: view(this.#lookup(key)) };
  }

  async read(owner: Owner, clientOperationId: string): Promise<FeedbackResult | null> {
    const receipt = this.#records.lookupReceipt(owner, clientOperationId);
    if (!receipt) return null;
    const key = this.#key(owner, receipt);
    const row = this.#lookup(key);
    if (row?.status !== "pending" || !row.session_id) return { receipt, feedback: view(row) };

    try {
      const runtime = this.#runtime;
      let turnId = row.turn_id;
      if (!turnId && row.turn_key && "findSubmittedTurn" in runtime) {
        const candidate = await runtime.findSubmittedTurn(owner, row.session_id, row.turn_key);
        if (candidate && this.#bindTurn(key, candidate)) turnId = candidate;
      }
      if (turnId) {
        const result = await runtime.observe(owner, row.session_id, turnId);
        if (result.status !== "pending") {
          this.#db.prepare(`UPDATE feedback SET status = ?, item_id = ?, answer = ?
            WHERE tenant_id = ? AND owner_id = ? AND operation_id = ? AND record_version = ?
            AND status = 'pending' AND turn_id = ?`)
            .run(result.status, result.status === "completed" ? result.itemId : null,
              result.status === "completed" ? result.text : null, ...key, turnId);
        }
      }
    } catch {
      // A read or publication failure leaves the operation available for a later read.
    }
    return { receipt, feedback: view(this.#lookup(key)) };
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
