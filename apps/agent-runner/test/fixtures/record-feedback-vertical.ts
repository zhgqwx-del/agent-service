import { execFile } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MysqlSessionStore } from "@agent-service/store";
import type { FakeVendor } from "@agent-service/testkit";
import { expect, vi } from "vitest";
import { createAgentServiceClient, subscribeSessionEvents } from "../../../../packages/sdk/src/index.js";
import { createRouterFeedbackRuntime } from "../../../../examples/record-assistant/fixtures/feedback-http.js";
import { RecordFeedback } from "../../../../examples/record-assistant/fixtures/feedback.js";
import {
  FakeRecordService, type CommitReceipt, type ConfirmedDrink,
} from "../../../../examples/record-assistant/fixtures/record-fixtures.js";

export type RecordRuntimeFixture = {
  owner: { tenantId: string; userId: string };
  connection: { baseUrl: string; serviceApiKey: string; userId: string; signal: AbortSignal };
  agent: { id: string; version: number };
  scratch: string;
  vendor: FakeVendor;
  trackSession(id: string): void;
  beforeVendorResponse(hook: (() => Promise<void>) | undefined): void;
  openCold(): Promise<MysqlSessionStore>;
};

const drink: Omit<ConfirmedDrink, "clientOperationId"> = {
  occurredAt: "2026-11-24T14:30:00-08:00",
  timeZone: "America/Los_Angeles",
  value: "300", unit: "ml", beverageKind: "water",
};
const stream = { streamId: "diandi-feedback-vertical", initialSequence: 10 };

function modelInput(request: Readonly<Record<string, unknown>> | undefined) {
  const messages = request?.messages as { role: string; content: string | { text: string }[] }[];
  const user = messages.filter(message => !["system", "developer"].includes(message.role));
  expect(user.map(message => message.role)).toEqual(["user"]);
  const content = user[0]!.content;
  return JSON.parse(typeof content === "string" ? content : content.map(part => part.text).join(""));
}

export async function verifyRecordFeedback(scope: RecordRuntimeFixture) {
  const { connection, agent, vendor } = scope;
  const owner = { tenantId: scope.owner.tenantId, ownerId: scope.owner.userId };
  const recordsPath = join(scope.scratch, "diandi-records.sqlite");
  const feedbackPath = join(scope.scratch, "diandi-feedback.sqlite");
  const expected = new Map<string, { operation: string; receipt: CommitReceipt }>();
  const submissions: { sessionId: string; key: string | null }[] = [];

  const client = createAgentServiceClient({
    ...connection,
    fetch: async input => {
      const request = new Request(input, { signal: connection.signal });
      const turnPost = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(new URL(request.url).pathname);
      if (turnPost && request.method === "POST") {
        const sessionId = turnPost[1]!;
        const record = expected.get(sessionId);
        expect(record).toBeDefined();
        // Open a separate SQLite reader at the actual HTTP submission boundary.
        const proof = new FakeRecordService(recordsPath, stream);
        try {
          expect(proof.lookupReceipt(owner, record!.operation)).toEqual(record!.receipt);
          expect(record!.receipt.status).toBe("committed");
        } finally { proof.close(); }
        const key = request.headers.get("idempotency-key");
        expect(key).toMatch(/^record-feedback-[a-f0-9]{64}$/);
        submissions.push({ sessionId, key });
      }
      return fetch(request);
    },
  });
  const open = () => {
    const records = new FakeRecordService(recordsPath, stream);
    try {
      const feedback = new RecordFeedback(feedbackPath, records, createRouterFeedbackRuntime(client, owner));
      return { records, feedback, close() { feedback.close(); records.close(); } };
    } catch (error) { records.close(); throw error; }
  };
  let local = open();
  const reopen = () => { local.close(); local = open(); };
  const listTurns = async (id: string) => {
    const result = await client.GET("/v1/sessions/{id}/turns", { params: { path: { id }, query: { limit: 10 } } });
    expect(result.response.status).toBe(200);
    return result.data!.data;
  };
  const start = async (operation: string, context: { requested: boolean; bottleCapacityMl?: number }) => {
    const receipt = local.records.commit(owner, { ...drink, clientOperationId: operation });
    const created = await client.POST("/v1/sessions", {
      body: { agentId: agent.id, agentVersion: agent.version, metadata: {} },
    });
    expect(created.response.status).toBe(201);
    expect(created.data).toMatchObject({ tenantId: owner.tenantId, userId: owner.ownerId });
    const sessionId = created.data!.id;
    scope.trackSession(sessionId);
    expected.set(sessionId, { operation, receipt });
    const result = await local.feedback.start(owner, operation, context, sessionId);
    expect(result?.receipt).toEqual(receipt);
    if (result?.feedback.status !== "pending" || !result.feedback.turnId) throw new Error("Expected a bound HTTP turn");
    expect(result.feedback.sessionId).toBe(sessionId);
    return { operation, receipt, sessionId, turnId: result.feedback.turnId };
  };
  const waitForResult = (started: Awaited<ReturnType<typeof start>>, status: "completed" | "failed") =>
    vi.waitFor(async () => {
      const result = await local.feedback.read(owner, started.operation);
      expect(result).toMatchObject({ receipt: started.receipt, feedback: { status, turnId: started.turnId, sessionId: started.sessionId } });
      return result!;
    }, { timeout: 12_000 });

  const release = Promise.withResolvers<void>();
  const disconnect = new AbortController();
  const reconnect = new AbortController();
  const answer = "已记下 300 毫升水。";
  const usefulAnswer = "300 毫升，约是这瓶水的 60%。";
  vendor.script({ text: answer }, { text: usefulAnswer }, { httpError: { status: 400 } }, { text: answer });
  try {
    const skipped = local.records.commit(owner, { ...drink, clientOperationId: "saved-only" });
    expect(await local.feedback.start(owner, "saved-only", { requested: false })).toEqual({ receipt: skipped, feedback: { status: "skipped" } });
    reopen();
    expect(await local.feedback.read(owner, "saved-only")).toEqual({ receipt: skipped, feedback: { status: "skipped" } });
    expect(local.records.counts()).toEqual({ records: 1, receipts: 1, outbox: 1 });
    const sessions = await client.GET("/v1/sessions");
    expect(sessions.response.status).toBe(200);
    expect(sessions.data?.data).toEqual([]);
    expect(submissions).toHaveLength(0);
    expect(vendor.ioSnapshot.requests).toBe(0);

    const requested = await start("requested", { requested: true });
    const explicit = await waitForResult(requested, "completed");
    expect(explicit.feedback).toMatchObject({ trigger: "requested", text: answer });
    expect(modelInput(vendor.requests[0]?.body)).toEqual({
      trigger: "requested", record: local.records.readRecord(owner, requested.receipt.recordId),
    });
    expect(submissions).toHaveLength(1);
    expect(vendor.ioSnapshot.requests).toBe(1);

    scope.beforeVendorResponse(() => release.promise);
    const useful = await start("useful", { requested: false, bottleCapacityMl: 500 });
    await vi.waitFor(() => expect(vendor.ioSnapshot.accepted).toBe(2));
    const initial = await subscribeSessionEvents({ ...connection, signal: AbortSignal.any([connection.signal, disconnect.signal]) }, useful.sessionId);
    let cursor: string | undefined;
    for await (const event of initial.events) {
      if (event.data.type === "turn/started" && event.data.turn.id === useful.turnId) {
        cursor = event.id;
        disconnect.abort();
        break;
      }
    }
    const afterSeq = Number(cursor);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 1) throw new Error("Missing live turn start cursor");
    expect(await local.feedback.read(owner, useful.operation)).toMatchObject({
      receipt: useful.receipt, feedback: { status: "pending", turnId: useful.turnId },
    });
    reopen();
    expect(await local.feedback.read(owner, useful.operation)).toMatchObject({
      receipt: useful.receipt, feedback: { status: "pending", turnId: useful.turnId },
    });
    const resumed = await subscribeSessionEvents({ ...connection, signal: AbortSignal.any([connection.signal, reconnect.signal]) },
      useful.sessionId, { lastEventId: afterSeq });
    release.resolve();
    scope.beforeVendorResponse(undefined);
    const terminals: { id?: string; turnId: string; status: string; stopReason?: string }[] = [];
    for await (const event of resumed.events) {
      expect(Number(event.id)).toBeGreaterThan(afterSeq);
      if (event.data.type === "turn/completed") terminals.push({
        id: event.id, turnId: event.data.turn.id, status: event.data.turn.status, stopReason: event.data.turn.stopReason,
      });
      if (terminals.length && event.data.type === "session/status/changed" && event.data.status.type === "idle") break;
    }
    expect(terminals).toEqual([expect.objectContaining({ turnId: useful.turnId, status: "completed", stopReason: "end_turn" })]);
    const recovered = await waitForResult(useful, "completed");
    expect(recovered.feedback).toMatchObject({ trigger: "useful", text: usefulAnswer });
    expect(modelInput(vendor.requests[1]?.body)).toEqual({
      trigger: "useful", record: local.records.readRecord(owner, useful.receipt.recordId), bottle: { capacityMl: 500, percent: 60 },
    });
    expect(submissions).toHaveLength(2);
    expect(vendor.ioSnapshot.requests).toBe(2);
    for (const [started, original, context] of [
      [requested, explicit, { requested: true }],
      [useful, recovered, { requested: false, bottleCapacityMl: 500 }],
    ] as const) {
      expect(local.records.commit(owner, { ...drink, clientOperationId: started.operation })).toEqual(started.receipt);
      expect(await local.feedback.start(owner, started.operation, context, started.sessionId)).toEqual(original);
    }

    const failed = await start("vendor-error", { requested: true });
    const failedResult = await waitForResult(failed, "failed");
    reopen();
    expect(await local.feedback.read(owner, failed.operation)).toEqual(failedResult);
    expect(await local.feedback.start(owner, failed.operation, { requested: true }, failed.sessionId)).toEqual(failedResult);

    const publication = await start("publication-error", { requested: true });
    await vi.waitFor(async () => {
      expect(await listTurns(publication.sessionId)).toEqual([
        expect.objectContaining({ id: publication.turnId, status: "completed", stopReason: "end_turn" }),
      ]);
    }, { timeout: 12_000 });
    const db = new DatabaseSync(feedbackPath);
    try {
      db.exec(`CREATE TRIGGER fixture_fail_publish BEFORE UPDATE ON feedback
        WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture publication failed'); END;`);
      expect(await local.feedback.read(owner, publication.operation)).toMatchObject({
        receipt: publication.receipt, feedback: { status: "pending", turnId: publication.turnId },
      });
      db.exec("DROP TRIGGER fixture_fail_publish");
    } finally { db.close(); }
    reopen();
    const published = await waitForResult(publication, "completed");
    expect(published.feedback).toMatchObject({ text: answer });

    const operations = [requested, useful, failed, publication];
    for (const operation of operations) {
      expect((await listTurns(operation.sessionId)).map(turn => turn.id)).toEqual([operation.turnId]);
      expect(local.records.lookupReceipt(owner, operation.operation)).toEqual(operation.receipt);
    }
    expect(submissions.map(submission => submission.sessionId)).toEqual(operations.map(operation => operation.sessionId));
    expect(new Set(submissions.map(submission => submission.key)).size).toBe(4);
    expect(local.records.counts()).toEqual({ records: 5, receipts: 5, outbox: 5 });

    const cold = await scope.openCold();
    for (const [operation, result] of [[requested, explicit], [useful, recovered], [publication, published]] as const) {
      const turn = await cold.getTurn(operation.sessionId, operation.turnId);
      expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 1, toolCalls: 0 });
      if (result.feedback.status !== "completed") throw new Error("Expected recovered final feedback");
      const items = await cold.listItems(operation.sessionId, { turnId: operation.turnId, limit: 20 });
      expect(items.filter(item => item.type === "agentMessage" && item.phase === "finalAnswer")).toEqual([
        expect.objectContaining({ id: result.feedback.itemId, text: result.feedback.text, status: "completed", turnId: operation.turnId }),
      ]);
    }
    expect(vendor.ioSnapshot).toMatchObject({ requests: 4, accepted: 4, closed: 4, active: 0 });
    console.log(JSON.stringify({
      AC01: { sameReceiptAfterReopen: true, sessions: 0, turnPosts: 0, vendorRequests: 0 },
      AC02: { triggers: ["requested", "useful"], receiptBeforePost: true, turnPostsPerTrigger: 1, vendorRequestsPerTrigger: 1, mysqlFinalItems: 2 },
      AC07: { disconnectedAtSeq: afterSeq, resumedTerminalSeq: Number(terminals[0]!.id), sameReceiptTurnAndFinalItem: true,
        vendorFailureSaved: true, publicationFailureRecovered: true, totalTurnPosts: 4, totalVendorRequests: 4, records: 5 },
    }));
  } finally {
    release.resolve();
    disconnect.abort();
    reconnect.abort();
    scope.beforeVendorResponse(undefined);
    local.close();
  }
}

function reloadFeedback(
  { signal, ...connection }: RecordRuntimeFixture["connection"],
  operation: { recordsPath: string; feedbackPath: string; owner: { tenantId: string; ownerId: string }; operation: string },
  waitForCompletion = false,
): Promise<{ pid: number; methods: string[]; result: Awaited<ReturnType<RecordFeedback["read"]>>;
  counts: ReturnType<FakeRecordService["counts"]> }> {
  const program = `
    import { setTimeout as sleep } from "node:timers/promises";
    import { createAgentServiceClient } from "./packages/sdk/src/index.ts";
    import { RecordFeedback } from "./examples/record-assistant/fixtures/feedback.ts";
    import { createRouterFeedbackRuntime } from "./examples/record-assistant/fixtures/feedback-http.ts";
    import { FakeRecordService } from "./examples/record-assistant/fixtures/record-fixtures.ts";
    process.stdin.setEncoding("utf8");
    let source = "";
    for await (const chunk of process.stdin) source += chunk;
    const { connection, recordsPath, feedbackPath, owner, operation, stream, waitForCompletion } = JSON.parse(source);
    const methods = [];
    const client = createAgentServiceClient({ ...connection, signal: AbortSignal.timeout(8_000), fetch: request => {
      methods.push(request.method);
      if (request.method !== "GET") throw new Error("Restarted caller may only read");
      return fetch(request);
    } });
    const records = new FakeRecordService(recordsPath, stream);
    const feedback = new RecordFeedback(feedbackPath, records, createRouterFeedbackRuntime(client, owner));
    try {
      const read = () => feedback.read(owner, operation);
      const [first] = await Promise.all([read(), feedback.start(owner, operation, { requested: true })]);
      const deadline = Date.now() + 7_000;
      let result = first;
      while (waitForCompletion && result?.feedback.status === "pending" && Date.now() < deadline) {
        await sleep(40);
        result = await read();
      }
      process.stdout.write(JSON.stringify({ pid: process.pid, methods, result, counts: records.counts() }));
    } finally { feedback.close(); records.close(); }
  `;
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program],
      { signal, timeout: 10_000, killSignal: "SIGKILL" }, (error, stdout) => {
        if (error) return reject(error);
        try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
      });
    child.stdin!.on("error", reject);
    // The new process receives the fixture credential and original client operation key over stdin.
    child.stdin!.end(JSON.stringify({ ...operation, connection, stream, waitForCompletion }));
  });
}

export async function verifyFirstTurnResponseLoss(scope: RecordRuntimeFixture) {
  const { connection, agent, vendor } = scope;
  const owner = { tenantId: scope.owner.tenantId, ownerId: scope.owner.userId };
  const recordsPath = join(scope.scratch, "lost-response-records.sqlite");
  const feedbackPath = join(scope.scratch, "lost-response-feedback.sqlite");
  const operation = "first-turn-response-lost";
  const context = { requested: true };
  const answer = "已记录这次的 300 毫升饮水。";
  const release = Promise.withResolvers<void>();
  const methods: string[] = [];
  const rejectedReads: string[] = [];
  let acceptedPosts = 0;
  let postKey: string | null = null;
  const lookupFailures = ["unavailable", "missing", "wrongKey", "ambiguous", "partial"] as const;
  let fault: "lostPost" | (typeof lookupFailures)[number] = "lostPost";
  const audit = createAgentServiceClient(connection);
  const appClient = () => createAgentServiceClient({
    ...connection,
    fetch: async request => {
      methods.push(request.method);
      const path = new URL(request.url).pathname;
      const response = await fetch(request);
      if (!/^\/v1\/sessions\/[^/]+\/turns$/.test(path)) return response;
      if (request.method === "POST" && fault === "lostPost") {
        expect(response.status).toBe(202);
        acceptedPosts++;
        postKey = request.headers.get("idempotency-key");
        await response.body?.cancel();
        throw new TypeError("Fixture disconnected before reading the accepted POST body");
      }
      if (request.method !== "GET") return response;
      if (fault === "unavailable") {
        rejectedReads.push(fault);
        await response.body?.cancel();
        return Response.json({ error: { message: "fixture lookup unavailable" } }, { status: 503 });
      }
      if (fault !== "lostPost") {
        rejectedReads.push(fault);
        const page = await response.json() as {
          data: { id: string; metadata?: Record<string, unknown> }[];
          nextCursor: string | null;
        };
        const [turn] = page.data;
        if (!turn) throw new Error("Expected the original turn before applying read fault");
        if (fault === "missing") page.data = [];
        if (fault === "wrongKey") turn.metadata = { diandiFeedbackKey: "unrelated" };
        if (fault === "ambiguous") page.data.push({ ...turn, id: "turn_00000000-0000-7000-8000-000000000000" });
        if (fault === "partial") page.nextCursor = "fixture-extra-page";
        return Response.json(page);
      }
      return response;
    },
  });
  const open = () => {
    const records = new FakeRecordService(recordsPath, stream);
    const feedback = new RecordFeedback(feedbackPath, records, createRouterFeedbackRuntime(appClient(), owner));
    return { records, feedback, close() { feedback.close(); records.close(); } };
  };
  let app = open();
  vendor.script({ text: answer });
  scope.beforeVendorResponse(() => release.promise);
  try {
    const receipt = app.records.commit(owner, { ...drink, clientOperationId: operation });
    const created = await audit.POST("/v1/sessions", {
      body: { agentId: agent.id, agentVersion: agent.version, metadata: {} },
    });
    expect(created.response.status).toBe(201);
    const id = created.data!.id;
    scope.trackSession(id);
    const unknown = { receipt, feedback: { status: "pending", trigger: "requested", sessionId: id, turnId: null } };
    expect(await app.feedback.start(owner, operation, context, id)).toEqual(unknown);
    expect(acceptedPosts).toBe(1);
    await vi.waitFor(() => expect(vendor.ioSnapshot.accepted).toBe(1));
    const params = { path: { id }, query: { limit: 2 } };
    const original = await audit.GET("/v1/sessions/{id}/turns", { params });
    expect(postKey).toMatch(/^record-feedback-[a-f0-9]{64}$/);
    expect(original.data?.data).toEqual([expect.objectContaining({
      sessionId: id, status: "inProgress", metadata: { diandiFeedbackKey: postKey },
    })]);
    const originalTurnId = original.data!.data[0]!.id;

    app.close();
    app = open();
    for (const failure of lookupFailures) {
      fault = failure;
      expect(await app.feedback.read(owner, operation)).toEqual(unknown);
      expect(await app.feedback.start(owner, operation, context)).toEqual(unknown);
    }
    expect(rejectedReads).toEqual(lookupFailures.flatMap(failure => [failure, failure]));
    expect(methods.filter(method => method === "POST")).toHaveLength(1);
    expect(vendor.ioSnapshot.requests).toBe(1);
    app.close();

    const lookup = { recordsPath, feedbackPath, owner, operation };
    const pending = await reloadFeedback(connection, lookup);
    expect(pending.pid).not.toBe(process.pid);
    expect(pending.methods.length).toBeGreaterThan(0);
    expect(new Set(pending.methods)).toEqual(new Set(["GET"]));
    expect(pending.result).toEqual({
      ...unknown, feedback: { ...unknown.feedback, turnId: originalTurnId },
    });

    release.resolve();
    const completed = await reloadFeedback(connection, lookup, true);
    const { result } = completed;
    expect(completed.pid).not.toBe(process.pid);
    expect(result).toMatchObject({ receipt, feedback: {
      status: "completed", sessionId: id, turnId: originalTurnId, text: answer,
    } });
    if (result?.feedback.status !== "completed") throw new Error("Expected original final reply");
    expect(new Set(completed.methods)).toEqual(new Set(["GET"]));
    expect(completed.counts).toEqual({ records: 1, receipts: 1, outbox: 1 });
    const stillOne = await audit.GET("/v1/sessions/{id}/turns", { params });
    expect(stillOne.data?.data.map(turn => turn.id)).toEqual([originalTurnId]);
    const cold = await scope.openCold();
    expect(await cold.getTurn(id, originalTurnId)).toMatchObject({ status: "completed", stopReason: "end_turn" });
    expect((await cold.listItems(id, { turnId: originalTurnId, limit: 20 })).filter(
      item => item.type === "agentMessage" && item.phase === "finalAnswer",
    )).toEqual([expect.objectContaining({ id: result.feedback.itemId, text: answer, turnId: originalTurnId })]);
    expect(vendor.ioSnapshot).toMatchObject({ requests: 1, accepted: 1, completed: 1, active: 0 });
    console.log(JSON.stringify({ AC07: { acceptedPosts, sameReceipt: true, sameTurn: true, sameFinalItem: true,
      callerProcessesReopened: 2, restartMethods: ["GET"], withheldBindingOn: lookupFailures, modelRequests: 1 } }));
  } finally {
    release.resolve();
    scope.beforeVendorResponse(undefined);
    app.close();
  }
}
