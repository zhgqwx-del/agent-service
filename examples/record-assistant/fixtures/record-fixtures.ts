import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

type Owner = { tenantId: string; ownerId: string };
type Stream = { streamId: string; initialSequence: number };
type DrinkFields = {
  occurredAt: string;
  timeZone: string;
  value: string;
  unit: "ml";
  beverageKind: "water";
};

export type ConfirmedDrink = DrinkFields & { clientOperationId: string };
export type SavedDrink = DrinkFields & { recordId: string; recordVersion: number };
export type CommitReceipt = {
  status: "committed";
  operationId: string;
  actionId: string;
  recordId: string;
  recordVersion: number;
};

type IncompleteDrink = { clientOperationId: string; rawInput: string };
type PendingDrinkOperation = {
  operationId: string;
  status: "pending_input";
  rawInput: string;
  missingFields: ["amount"];
};

export type RecordEvent = {
  streamId: string;
  sequence: number;
  eventId: string;
  payloadHash: string;
  payload: {
    mode: "ordered_import";
    sourceKind: "external_record";
    authorityKind: "external_committed";
    tenantId: string;
    ownerId: string;
    sourceId: string;
    sourceGroupId: string;
    externalRecordRef: { systemId: string; recordId: string; externalVersion: string };
    record: SavedDrink;
  };
};

type MemoryReceipt = { status: "accepted" | "applied"; operationId: string; eventId: string };
type MemoryTransport = {
  receive(event: RecordEvent): MemoryReceipt;
  lookupOperation(operationId: string): MemoryReceipt;
};
type OutboxDelivery = {
  event: RecordEvent;
  memoryOperationId: string | null;
  memoryStatus: "pending" | "applied";
};
type OutboxRow = { event_json: string; memory_operation_id: string | null; applied: number };
type CommitPhase = "beforeCommit" | "afterCommit";
const confirmedInputFields = ["clientOperationId", "occurredAt", "timeZone", "value", "unit", "beverageKind"];
const incompleteInputFields = ["clientOperationId", "rawInput"];

class MemoryUnavailable extends Error {}

function checkInputFields(input: object, fields: readonly string[]): void {
  if (Object.keys(input).some((key) => !fields.includes(key))) {
    throw Object.assign(new Error("Unexpected field in fixture input"), { code: "UNTRUSTED_FIELD" });
  }
}

function operationConflict(message: string): Error {
  return Object.assign(new Error(message), { code: "IDEMPOTENCY_CONFLICT" });
}

function digest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function openStore(path: string, stream: Stream, schema: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS stream (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      stream_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
    ); ${schema}`);
    db.prepare("INSERT OR IGNORE INTO stream VALUES (1, ?, ?)").run(stream.streamId, stream.initialSequence);
    if (db.prepare("SELECT stream_id FROM stream WHERE slot = 1").get()?.stream_id !== stream.streamId) {
      throw new Error("This fixture store belongs to another stream");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function writeTransaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = write();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function lastSequence(db: DatabaseSync): number {
  return (db.prepare("SELECT last_sequence FROM stream WHERE slot = 1").get() as { last_sequence: number }).last_sequence;
}

function readDelivery(row: OutboxRow): OutboxDelivery {
  return {
    event: JSON.parse(row.event_json),
    memoryOperationId: row.memory_operation_id,
    memoryStatus: row.applied ? "applied" : "pending",
  };
}

/** Local contract fixture. A trusted caller supplies owner identity and classifies the drink input. */
export class FakeRecordService {
  #db: DatabaseSync;
  #streamId: string;

  constructor(path: string, stream: Stream) {
    this.#streamId = stream.streamId;
    this.#db = openStore(path, stream, `
      CREATE TABLE IF NOT EXISTS records (
        record_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        client_operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        record_id TEXT NOT NULL UNIQUE REFERENCES records(record_id),
        PRIMARY KEY (tenant_id, owner_id, client_operation_id)
      );
      CREATE TABLE IF NOT EXISTS pending_drinks (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        client_operation_id TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        raw_input TEXT NOT NULL,
        PRIMARY KEY (tenant_id, owner_id, client_operation_id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        sequence INTEGER PRIMARY KEY,
        event_json TEXT NOT NULL,
        memory_operation_id TEXT,
        applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1))
      );
    `);
  }

  forOwner(trustedOwner: Owner) {
    const owner = { tenantId: trustedOwner.tenantId, ownerId: trustedOwner.ownerId };
    return {
      retainIncompleteDrink: (input: IncompleteDrink) => {
        checkInputFields(input, incompleteInputFields);
        return this.#retainIncompleteDrink(owner, input);
      },
      commit: (input: ConfirmedDrink) => {
        checkInputFields(input, confirmedInputFields);
        return this.commit(owner, input);
      },
      lookupOperation: (key: string) => this.lookupReceipt(owner, key) ?? this.#lookupPendingDrink(owner, key),
      lookupReceipt: (key: string) => this.lookupReceipt(owner, key),
      readRecord: (id: string) => this.readRecord(owner, id),
    };
  }

  #lookup(owner: Owner, clientOperationId: string) {
    return this.#db.prepare(`SELECT request_hash, receipt_json FROM receipts
      WHERE tenant_id = ? AND owner_id = ? AND client_operation_id = ?`)
      .get(owner.tenantId, owner.ownerId, clientOperationId) as
        { request_hash: string; receipt_json: string } | undefined;
  }

  #lookupPendingDrink(owner: Owner, clientOperationId: string): PendingDrinkOperation | null {
    const row = this.#db.prepare(`SELECT operation_id, raw_input FROM pending_drinks
      WHERE tenant_id = ? AND owner_id = ? AND client_operation_id = ?`)
      .get(owner.tenantId, owner.ownerId, clientOperationId) as { operation_id: string; raw_input: string } | undefined;
    return row ? { operationId: row.operation_id, status: "pending_input", rawInput: row.raw_input, missingFields: ["amount"] }
      : null;
  }

  #retainIncompleteDrink(owner: Owner, input: IncompleteDrink): PendingDrinkOperation {
    return writeTransaction(this.#db, () => {
      const { clientOperationId, rawInput } = input;
      if (this.#lookup(owner, clientOperationId)) {
        throw operationConflict("Operation key is already bound to a committed drink");
      }
      const existing = this.#lookupPendingDrink(owner, clientOperationId);
      if (existing) {
        if (existing.rawInput !== rawInput) throw operationConflict("Operation key is already bound to another input");
        return existing;
      }

      const operationId = randomUUID();
      this.#db.prepare(`INSERT INTO pending_drinks (tenant_id, owner_id, client_operation_id, operation_id, raw_input)
        VALUES (?, ?, ?, ?, ?)`).run(owner.tenantId, owner.ownerId, clientOperationId, operationId, rawInput);
      return { operationId, status: "pending_input", rawInput, missingFields: ["amount"] };
    });
  }

  commit(owner: Owner, drink: ConfirmedDrink, fault?: (phase: CommitPhase) => void): CommitReceipt {
    // Pick confirmed fields in a fixed order before hashing. Retries never get a new time basis.
    const fields: DrinkFields = {
      occurredAt: drink.occurredAt,
      timeZone: drink.timeZone,
      value: drink.value,
      unit: drink.unit,
      beverageKind: drink.beverageKind,
    };
    const requestHash = digest(fields);
    const result = writeTransaction(this.#db, () => {
      const existing = this.#lookup(owner, drink.clientOperationId);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw operationConflict("Operation key is already bound to a different drink");
        }
        return { receipt: JSON.parse(existing.receipt_json) as CommitReceipt, created: false };
      }
      if (this.#lookupPendingDrink(owner, drink.clientOperationId)) {
        throw operationConflict("Operation key is already bound to pending input");
      }

      const record: SavedDrink = { recordId: randomUUID(), recordVersion: 1, ...fields };
      const receipt: CommitReceipt = {
        status: "committed",
        operationId: randomUUID(),
        actionId: randomUUID(),
        recordId: record.recordId,
        recordVersion: record.recordVersion,
      };
      const payload: RecordEvent["payload"] = {
        mode: "ordered_import",
        sourceKind: "external_record",
        authorityKind: "external_committed",
        tenantId: owner.tenantId,
        ownerId: owner.ownerId,
        sourceId: randomUUID(),
        sourceGroupId: randomUUID(),
        externalRecordRef: {
          systemId: "record-service-fixture",
          recordId: record.recordId,
          externalVersion: String(record.recordVersion),
        },
        record,
      };
      const event: RecordEvent = {
        streamId: this.#streamId,
        sequence: lastSequence(this.#db) + 1,
        eventId: randomUUID(),
        payloadHash: digest(payload),
        payload,
      };
      this.#db.prepare("INSERT INTO records VALUES (?, ?, ?, ?)")
        .run(record.recordId, owner.tenantId, owner.ownerId, JSON.stringify(record));
      this.#db.prepare("INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?)")
        .run(owner.tenantId, owner.ownerId, drink.clientOperationId, requestHash, JSON.stringify(receipt), record.recordId);
      this.#db.prepare("INSERT INTO outbox (sequence, event_json) VALUES (?, ?)")
        .run(event.sequence, JSON.stringify(event));
      this.#db.prepare("UPDATE stream SET last_sequence = ? WHERE slot = 1").run(event.sequence);
      fault?.("beforeCommit");
      return { receipt, created: true };
    });
    if (result.created) fault?.("afterCommit");
    return result.receipt;
  }

  lookupReceipt(owner: Owner, clientOperationId: string): CommitReceipt | null {
    const row = this.#lookup(owner, clientOperationId);
    return row ? JSON.parse(row.receipt_json) : null;
  }

  readRecord(owner: Owner, recordId: string): SavedDrink | null {
    const row = this.#db.prepare(`SELECT record_json FROM records
      WHERE record_id = ? AND tenant_id = ? AND owner_id = ?`)
      .get(recordId, owner.tenantId, owner.ownerId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : null;
  }

  listOutbox(): OutboxDelivery[] {
    const rows = this.#db.prepare("SELECT * FROM outbox ORDER BY sequence").all() as OutboxRow[];
    return rows.map(readDelivery);
  }

  counts(): { records: number; receipts: number; outbox: number } {
    const counts = this.#db.prepare(`SELECT (SELECT count(*) FROM records) AS records,
      (SELECT count(*) FROM receipts) AS receipts, (SELECT count(*) FROM outbox) AS outbox`).get();
    return { ...(counts as { records: number; receipts: number; outbox: number }) };
  }

  dispatchNext(memory: MemoryTransport): OutboxDelivery | null {
    const row = this.#db.prepare("SELECT * FROM outbox WHERE applied = 0 ORDER BY sequence LIMIT 1")
      .get() as OutboxRow | undefined;
    if (!row) return null;
    const pending = readDelivery(row);
    let receipt: MemoryReceipt;
    try {
      receipt = pending.memoryOperationId === null
        ? memory.receive(pending.event)
        : memory.lookupOperation(pending.memoryOperationId);
    } catch (error) {
      if (error instanceof MemoryUnavailable) return pending;
      throw error;
    }
    if (receipt.eventId !== pending.event.eventId) throw new Error("Memory receipt belongs to another event");
    const update = this.#db.prepare(`UPDATE outbox SET memory_operation_id = ?, applied = max(applied, ?)
      WHERE sequence = ? AND (memory_operation_id IS NULL OR memory_operation_id = ?)`)
      .run(receipt.operationId, Number(receipt.status === "applied"), pending.event.sequence, receipt.operationId);
    if (update.changes !== 1) throw new Error("Memory operation identity changed for the same event");
    const updated = this.#db.prepare("SELECT * FROM outbox WHERE sequence = ?").get(pending.event.sequence) as OutboxRow;
    return readDelivery(updated);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}

type InboxRow = { operation_id: string; event_id: string; sequence: number; payload_hash: string; applied: number };

function memoryReceipt(row: InboxRow): MemoryReceipt {
  return { operationId: row.operation_id, eventId: row.event_id, status: row.applied ? "applied" : "accepted" };
}

/** In-process transport with a separate durable inbox and an explicitly controlled application step. */
export class FakeMemoryReceiver {
  #db: DatabaseSync;
  #streamId: string;
  #online = true;
  #dropAcceptance = false;

  constructor(path: string, stream: Stream) {
    this.#streamId = stream.streamId;
    this.#db = openStore(path, stream, `
      CREATE TABLE IF NOT EXISTS inbox (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS applications (
        sequence INTEGER PRIMARY KEY REFERENCES inbox(sequence)
      );
    `);
  }

  setOnline(online: boolean): void {
    this.#online = online;
  }

  dropNextAcceptanceResponse(): void {
    this.#dropAcceptance = true;
  }

  #requireOnline(): void {
    if (!this.#online) throw new MemoryUnavailable("Memory fixture refused the connection");
  }

  receive(event: RecordEvent): MemoryReceipt {
    this.#requireOnline();
    if (event.streamId !== this.#streamId || event.payloadHash !== digest(event.payload)) {
      throw new Error("Unexpected stream or payload hash");
    }
    const receipt = writeTransaction(this.#db, () => {
      const prior = this.#db.prepare(`SELECT inbox.*, applications.sequence IS NOT NULL AS applied
        FROM inbox LEFT JOIN applications USING (sequence) WHERE inbox.sequence = ? OR event_id = ?`)
        .get(event.sequence, event.eventId) as InboxRow | undefined;
      if (prior) {
        if (prior.sequence !== event.sequence || prior.event_id !== event.eventId || prior.payload_hash !== event.payloadHash) {
          throw new Error("Conflicting event at a previously received identity or sequence");
        }
        return memoryReceipt(prior);
      }
      if (event.sequence <= lastSequence(this.#db)) throw new Error("Event is behind the registered stream position");
      const operationId = randomUUID();
      this.#db.prepare("INSERT INTO inbox VALUES (?, ?, ?, ?, ?)")
        .run(event.sequence, event.eventId, event.payloadHash, operationId, JSON.stringify(event));
      return { operationId, eventId: event.eventId, status: "accepted" } as const;
    });
    if (this.#dropAcceptance && receipt.status === "accepted") {
      this.#dropAcceptance = false;
      throw new MemoryUnavailable("Memory fixture lost a response after durable acceptance");
    }
    return receipt;
  }

  lookupOperation(operationId: string): MemoryReceipt {
    this.#requireOnline();
    const row = this.#db.prepare(`SELECT inbox.*, applications.sequence IS NOT NULL AS applied
      FROM inbox LEFT JOIN applications USING (sequence) WHERE operation_id = ?`)
      .get(operationId) as InboxRow | undefined;
    if (!row) throw new Error("Unknown Memory operation");
    return memoryReceipt(row);
  }

  applyNext(): RecordEvent | null {
    this.#requireOnline();
    return writeTransaction(this.#db, () => {
      const sequence = lastSequence(this.#db) + 1;
      const row = this.#db.prepare("SELECT event_json FROM inbox WHERE sequence = ?")
        .get(sequence) as { event_json: string } | undefined;
      if (!row) return null;
      this.#db.prepare("INSERT INTO applications VALUES (?)").run(sequence);
      this.#db.prepare("UPDATE stream SET last_sequence = ? WHERE slot = 1").run(sequence);
      return JSON.parse(row.event_json);
    });
  }

  snapshot(): { inbox: number; applied: number; throughSequence: number } {
    const row = this.#db.prepare(`SELECT (SELECT count(*) FROM inbox) AS inbox,
      (SELECT count(*) FROM applications) AS applied, last_sequence AS throughSequence FROM stream WHERE slot = 1`).get();
    return { ...(row as { inbox: number; applied: number; throughSequence: number }) };
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
