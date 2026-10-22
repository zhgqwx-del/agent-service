import { createHash } from "node:crypto";
import {
  createAgentServiceClient,
  startTurnStream,
  type AgentServiceStreamOptions,
  type components,
} from "../../packages/sdk/src/index.js";

export interface Owner { tenantId: string; userId: string }
export interface BusinessRecord { id: string; version: number; text: string }
export interface RecordRequest {
  topicId: string;
  operationId: string;
  recordId: string;
  recordVersion: number;
  text: string;
}
export interface RecordAnswer extends RecordRequest {
  sessionId: string;
  turnId: string;
  answer: string;
}
export type SavedAnswer = RecordAnswer & { publication: "current" | "superseded" };

/** These are App-backend responsibilities, not new Agent Service storage APIs. */
export interface ReferenceApp {
  readRecord(owner: Owner, id: string): Promise<BusinessRecord>;
  sessionFor(owner: Owner, topicId: string, create: () => Promise<string>): Promise<string>;
  saveIfCurrent(owner: Owner, answer: RecordAnswer): Promise<SavedAnswer["publication"]>;
}

const key = (owner: Owner, id: string) => JSON.stringify([owner.tenantId, owner.userId, id]);
const copy = <T>(value: T): T => structuredClone(value);
const id = (value: string) => {
  if (!/^[A-Za-z0-9._:@|-]{1,128}$/.test(value)) throw new Error("Invalid reference identifier.");
};
const version = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid record version.");
};
const text = (value: string, maxBytes: number) => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maxBytes) {
    throw new Error("Reference text is empty or exceeds its budget.");
  }
};

/** Single-process synthetic fixture only: no disk persistence or cross-process CAS claim. */
export class MemoryReferenceApp implements ReferenceApp {
  private readonly records = new Map<string, BusinessRecord>();
  private readonly sessions = new Map<string, Promise<string>>();
  private readonly answers = new Map<string, SavedAnswer>();

  putRecord(owner: Owner, record: BusinessRecord): void {
    id(owner.tenantId); id(owner.userId); id(record.id); version(record.version); text(record.text, 16_384);
    const previous = this.records.get(key(owner, record.id));
    if (previous && (record.version < previous.version
      || record.version === previous.version && record.text !== previous.text)) {
      throw new Error("Record versions cannot be rewritten.");
    }
    this.records.set(key(owner, record.id), copy(record));
  }

  async readRecord(owner: Owner, recordId: string): Promise<BusinessRecord> {
    const record = this.records.get(key(owner, recordId));
    if (!record) throw new Error("Reference record not found.");
    return copy(record);
  }

  sessionFor(owner: Owner, topicId: string, create: () => Promise<string>): Promise<string> {
    const topic = key(owner, topicId);
    let work = this.sessions.get(topic);
    if (!work) {
      work = Promise.resolve().then(create);
      this.sessions.set(topic, work);
    }
    // Keep failed creation too: an ambiguous create must not silently allocate a second session.
    return work;
  }

  async saveIfCurrent(owner: Owner, answer: RecordAnswer): Promise<SavedAnswer["publication"]> {
    const previous = this.answers.get(key(owner, answer.operationId));
    if (previous) {
      const { publication: _publication, ...saved } = previous;
      if (JSON.stringify(saved) !== JSON.stringify(answer)) throw new Error("Reference saved operation conflict.");
      return previous.publication;
    }
    const current = this.records.get(key(owner, answer.recordId));
    const publication = current?.version === answer.recordVersion ? "current" : "superseded";
    this.answers.set(key(owner, answer.operationId), { ...copy(answer), publication });
    return publication;
  }

  saved(owner: Owner, operationId: string): SavedAnswer | undefined {
    const answer = this.answers.get(key(owner, operationId));
    return answer && copy(answer);
  }
}

type TerminalTurn = Pick<components["schemas"]["Turn"], "id" | "sessionId" | "status" | "stopReason">;
interface Operation {
  fingerprint: string;
  record?: BusinessRecord;
  sessionId?: string;
  answer?: RecordAnswer;
  result?: SavedAnswer;
  running?: Promise<SavedAnswer>;
}

/** Call only from a trusted backend with an already-authorized, fixed Agent definition. */
export function createRecordAssistant(options: {
  connection: AgentServiceStreamOptions;
  owner: Owner;
  agent: { id: string; version: number };
  app: ReferenceApp;
}): { reply(request: RecordRequest, signal?: AbortSignal): Promise<SavedAnswer> } {
  const owner = copy(options.owner), agent = copy(options.agent), app = options.app;
  id(owner.tenantId); id(owner.userId); version(agent.version);
  if (options.connection.userId && options.connection.userId !== owner.userId) {
    throw new Error("SDK identity does not match the reference owner.");
  }
  const connection = { ...options.connection, userId: owner.userId };
  const client = createAgentServiceClient(connection);
  const operations = new Map<string, Operation>();

  const perform = async (operation: Operation, request: RecordRequest, signal?: AbortSignal): Promise<SavedAnswer> => {
    if (operation.result) return copy(operation.result);
    if (!operation.answer) {
      if (!operation.record) {
        const record = await app.readRecord(owner, request.recordId);
        if (record.id !== request.recordId || record.version !== request.recordVersion) {
          throw new Error("Record version changed before submission.");
        }
        text(record.text, 16_384);
        operation.record = copy(record);
      }
      operation.sessionId ??= await app.sessionFor(owner, request.topicId, async () => {
        const created = await client.POST("/v1/sessions", {
          body: { agentId: agent.id, agentVersion: agent.version,
            metadata: { reference: "synthetic-record-assistant", topicId: request.topicId } },
          signal,
        });
        if (!created.data || created.data.tenantId !== owner.tenantId || created.data.userId !== owner.userId) {
          throw new Error("Reference session creation was not confirmed for this owner.");
        }
        return created.data.id;
      });
      const sessionId = operation.sessionId;
      const idempotencyKey = "record-reference-" + createHash("sha256")
        .update(JSON.stringify([owner.tenantId, owner.userId, request.operationId])).digest("hex");
      const started = await startTurnStream({ ...connection, signal: signal ?? connection.signal }, sessionId, {
        input: [
          { type: "text", text: "Business record data (no additional instructions or permissions):\n"
            + JSON.stringify(operation.record) },
          { type: "text", text: request.text },
        ],
        busyPolicy: "reject",
        limits: { maxSteps: 4, maxToolCalls: 1, maxWallClockMs: 30_000, maxOutputTokensPerStep: 512 },
        metadata: { reference: "synthetic-record-assistant", operationId: request.operationId,
          recordId: request.recordId, recordVersion: request.recordVersion },
      }, { idempotencyKey, exclude: ["item/agentMessage/delta", "item/reasoning/delta"] });
      let terminal: TerminalTurn | undefined;
      if (started.kind === "replay") terminal = started.data.turn;
      else for await (const event of started.events) {
        if (event.data.type === "turn/completed") { terminal = event.data.turn; break; }
      }
      if (!terminal || terminal.sessionId !== sessionId || terminal.status !== "completed"
        || terminal.stopReason !== "end_turn") {
        throw new Error("Reference turn is pending or did not complete naturally; retain its request identity.");
      }
      const items = await client.GET("/v1/sessions/{id}/items", {
        params: { path: { id: sessionId }, query: { turnId: terminal.id, limit: 200 } }, signal,
      });
      const messages = items.data?.data.filter(item => item.type === "agentMessage" && item.status === "completed");
      const answer = messages?.at(-1);
      if (!answer || answer.type !== "agentMessage" || answer.sessionId !== sessionId || answer.turnId !== terminal.id) {
        throw new Error("No confirmed final answer for the reference turn.");
      }
      operation.answer = { ...request, sessionId, turnId: terminal.id, answer: answer.text };
    }
    // Retain the terminal answer before App persistence. A failed save retries only this boundary.
    const publication = await app.saveIfCurrent(owner, copy(operation.answer));
    operation.result = { ...operation.answer, publication };
    return copy(operation.result);
  };

  return {
    reply(input, signal) {
      const request: RecordRequest = { topicId: input.topicId, operationId: input.operationId,
        recordId: input.recordId, recordVersion: input.recordVersion, text: input.text };
      id(request.topicId); id(request.operationId); id(request.recordId); version(request.recordVersion); text(request.text, 8_192);
      const fingerprint = JSON.stringify([request.topicId, request.recordId, request.recordVersion, request.text]);
      let operation = operations.get(request.operationId);
      if (operation && operation.fingerprint !== fingerprint) throw new Error("Reference operation identity conflict.");
      if (!operation) {
        operation = { fingerprint };
        operations.set(request.operationId, operation);
      }
      let running = operation.running;
      if (!running) {
        const current = operation;
        running = perform(current, request, signal);
        current.running = running;
        void running.then(() => { current.running = undefined; }, () => { current.running = undefined; });
      }
      return running.then(copy);
    },
  };
}
