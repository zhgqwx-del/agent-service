import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi, type TestContext } from "vitest";
import { PiEngine, SessionHost, StaticToolRegistry, newId } from "@agent-service/core";
import type { AgentDefinition } from "@agent-service/protocol";
import { MemoryEventBus, MemorySessionStore } from "@agent-service/store";
import { FakeVendor, type FakeVendorOptions, type ScriptedReply } from "@agent-service/testkit";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";
import { FakeRecordService, type ConfirmedDrink } from "../../../examples/record-assistant/fixtures/record-fixtures.js";
import { RecordFeedback, createHostFeedbackRuntime } from "../../../examples/record-assistant/fixtures/feedback.js";

const owner = { tenantId: "diandi-feedback-fixture", ownerId: "fixture-self" };
const principal = { tenantId: owner.tenantId, userId: owner.ownerId };
const drink: ConfirmedDrink = {
  clientOperationId: "drink-1",
  occurredAt: "2026-11-24T14:30:00-08:00",
  timeZone: "America/Los_Angeles",
  value: "300",
  unit: "ml",
  beverageKind: "water",
};
const stream = { streamId: "feedback-records", initialSequence: 10 };
const key = drink.clientOperationId;
const oneRecord = { records: 1, receipts: 1, outbox: 1 };

async function fixture(context: TestContext, options: {
  reply?: ScriptedReply;
  beforeResponse?: FakeVendorOptions["beforeResponse"];
  releaseResponse?: () => void;
  maxSteps?: number;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "diandi-feedback-"));
  const recordsPath = join(dir, "records.sqlite");
  const feedbackPath = join(dir, "feedback.sqlite");
  const vendor = new FakeVendor({ expectApiKey: "feedback-only", beforeResponse: options.beforeResponse });
  vendor.script(options.reply ?? { text: "已记下 300 毫升水。" });
  const store = new MemorySessionStore();
  const bus = new MemoryEventBus();
  let host: SessionHost | undefined;
  const localStores: Array<{ close(): void }> = [];
  context.onTestFinished(async () => {
    options.releaseResponse?.();
    try {
      await host?.drain(1_000);
    } finally {
      await bus.close();
      await store.close();
      await vendor.stop();
      for (const local of localStores.reverse()) local.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const baseUrl = await vendor.start();
  const providers = new ProviderService({
    store, cipher: new LocalAesGcmCipher("12".repeat(32)),
    assertBaseUrl: async (url) => { expect(url).toBe(baseUrl); },
  });
  await providers.upsertTenantProvider(principal.tenantId, {
    id: "feedback-test", api: "openai-completions", baseUrl, apiKey: "feedback-only",
    headers: {}, quota: {}, fallback: [],
    models: [{
      id: "fake-model", contextWindow: 32_000, maxOutputTokens: 256, input: ["text"], reasoning: false,
      price: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0.4 },
    }],
  });
  const agent: AgentDefinition = {
    id: newId("agt"), version: 1, tenantId: principal.tenantId, name: "record feedback fixture",
    instructions: "Use only the confirmed facts in the current record. Reply with one brief sentence.",
    model: { provider: "feedback-test", model: "fake-model" },
    tools: [], mcpServers: [], skills: [], limits: { maxSteps: options.maxSteps ?? 4 },
    approvalPolicy: "on-request", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now(),
  };
  await store.createAgent(agent);
  const runtimeHost = new SessionHost({
    store, lease: store.sessionAuthority, bus, providers, engine: new PiEngine(providers.models),
    tools: new StaticToolRegistry([]), config: { runnerId: "feedback", runnerAddr: "local", leaseHoldMs: 10 },
    logger: { info() {}, warn() {}, error() {} },
  });
  host = runtimeHost;
  const session = await host.createSession(principal, { agentId: agent.id, agentVersion: agent.version, metadata: {} });
  const runtime = createHostFeedbackRuntime(host, store);
  const open = () => {
    const records = new FakeRecordService(recordsPath, stream);
    const feedback = new RecordFeedback(feedbackPath, records, runtime);
    localStores.push(records, feedback);
    return { records, feedback, close() { feedback.close(); records.close(); } };
  };
  return { ...open(), open, feedbackPath, vendor, store, host: runtimeHost, session };
}

type LocalFeedback = Awaited<ReturnType<typeof fixture>>;

async function waitForTerminal(h: LocalFeedback) {
  const turns = await h.store.listTurns(h.session.id, { limit: 10 });
  expect(turns.data).toHaveLength(1);
  const turnId = turns.data[0]!.id;
  return vi.waitFor(async () => {
    const turn = await h.store.getTurn(h.session.id, turnId);
    expect(turn).not.toBeNull();
    expect(turn?.status).not.toBe("inProgress");
    return turn!;
  });
}

function modelInput(vendor: FakeVendor): unknown {
  const messages = vendor.lastRequest?.body.messages as Array<{
    role: string; content: string | Array<{ type: string; text: string }>;
  }>;
  const userMessages = messages.filter((message) => message.role !== "system" && message.role !== "developer");
  expect(userMessages.map((message) => message.role)).toEqual(["user"]);
  const content = userMessages[0]!.content;
  return JSON.parse(typeof content === "string" ? content : content.map((part) => part.text).join(""));
}

it.for([undefined, 0, 299])("AC01 defaults to saved with no feedback for bottle capacity %s", async (capacity, context) => {
  const h = await fixture(context);
  const createSession = vi.spyOn(h.host, "createSession");
  expect(await h.feedback.start(owner, key, { requested: true }, h.session.id)).toBeNull();
  const receipt = h.records.commit(owner, drink);
  expect(await h.feedback.start(owner, key, { requested: false, bottleCapacityMl: capacity }, h.session.id))
    .toEqual({ receipt, feedback: { status: "skipped" } });
  h.close();
  const reopened = h.open();
  expect(await reopened.feedback.read(owner, key)).toEqual({ receipt, feedback: { status: "skipped" } });
  expect(await reopened.feedback.start(owner, key, { requested: true }, h.session.id))
    .toEqual({ receipt, feedback: { status: "skipped" } });
  expect(reopened.records.counts()).toEqual(oneRecord);
  expect(createSession).not.toHaveBeenCalled();
  expect((await h.store.listTurns(h.session.id, { limit: 10 })).data).toEqual([]);
  expect(await h.store.listItems(h.session.id, { limit: 20 })).toEqual([]);
  expect(h.vendor.ioSnapshot.requests).toBe(0);
});

it.for([undefined, 500])("AC02 explicit request dispatches once, including with bottle capacity %s", async (capacity, context) => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const h = await fixture(context, { beforeResponse: () => { entered.resolve(); return release.promise; }, releaseResponse: release.resolve });
  const receipt = h.records.commit(owner, drink);
  const options = { requested: true, bottleCapacityMl: capacity };
  const starts = await Promise.all([
    h.feedback.start(owner, key, options, h.session.id), h.feedback.start(owner, key, options, h.session.id),
  ]);
  expect(starts.map((state) => state?.receipt)).toEqual([receipt, receipt]);
  await entered.promise;
  expect(h.records.lookupReceipt(owner, key)).toEqual(receipt);
  expect(await h.feedback.read(owner, key)).toMatchObject({ receipt, feedback: { status: "pending", trigger: "requested" } });
  release.resolve();

  const turn = await waitForTerminal(h);
  expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn" });
  const result = await h.feedback.read(owner, key);
  expect(result).toMatchObject({ receipt, feedback: { status: "completed", trigger: "requested", turnId: turn.id, text: "已记下 300 毫升水。" } });
  const messages = (await h.store.listItems(h.session.id, { turnId: turn.id, limit: 20 })).filter((item) => item.type === "agentMessage");
  expect(messages).toHaveLength(1);
  expect(result?.feedback).toMatchObject({ itemId: messages[0]?.id });
  expect(modelInput(h.vendor)).toEqual({ trigger: "requested", record: h.records.readRecord(owner, receipt.recordId) });
  h.close();
  const reopened = h.open();
  expect(await reopened.feedback.start(owner, key, options, h.session.id)).toEqual(result);
  expect(reopened.records.counts()).toEqual(oneRecord);
  expect(h.vendor.ioSnapshot.requests).toBe(1);
});

it("AC02 the Agent adds a bottle proportion based only on confirmed current facts", async (context) => {
  const h = await fixture(context, { reply: { text: "这次喝了这瓶的 60%。" } });
  const receipt = h.records.commit(owner, drink);
  const record = h.records.readRecord(owner, receipt.recordId);
  const outbox = h.records.listOutbox();
  await h.feedback.start(owner, key, { requested: false, bottleCapacityMl: 500 }, h.session.id);
  const turn = await waitForTerminal(h);
  expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn" });
  expect(await h.feedback.read(owner, key)).toMatchObject({
    receipt, feedback: { status: "completed", trigger: "useful", turnId: turn.id, text: "这次喝了这瓶的 60%。" },
  });
  expect(modelInput(h.vendor)).toEqual({ trigger: "useful", record, bottle: { capacityMl: 500, percent: 60 } });
  expect(h.vendor.ioSnapshot.requests).toBe(1);
  expect(h.records.readRecord(owner, receipt.recordId)).toEqual(record);
  expect(h.records.listOutbox()).toEqual(outbox);
  expect(h.records.counts()).toEqual(oneRecord);
});

it("AC07 a provider failure leaves the original save receipt readable after restart", async (context) => {
  const h = await fixture(context, { reply: { httpError: { status: 400 } } });
  const receipt = h.records.commit(owner, drink);
  await h.feedback.start(owner, key, { requested: true }, h.session.id);
  const turn = await waitForTerminal(h);
  expect(turn.status).toBe("failed");
  h.close();
  const reopened = h.open();
  const failed = await reopened.feedback.read(owner, key);
  expect(failed).toMatchObject({ receipt, feedback: { status: "failed", turnId: turn.id } });
  expect(failed?.feedback).not.toHaveProperty("text");
  expect(await reopened.feedback.start(owner, key, { requested: true }, h.session.id)).toEqual(failed);
  expect(reopened.records.lookupReceipt(owner, key)).toEqual(receipt);
  expect(reopened.records.counts()).toEqual(oneRecord);
  expect(h.vendor.ioSnapshot.requests).toBe(1);
});

it("AC07 detaching the observer leaves the original turn pending, then recoverable", async (context) => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const h = await fixture(context, { beforeResponse: () => { entered.resolve(); return release.promise; }, releaseResponse: release.resolve });
  const receipt = h.records.commit(owner, drink);
  const detach = await h.host.subscribe(principal, h.session.id, 0, () => {});
  context.onTestFinished(detach);
  await h.feedback.start(owner, key, { requested: true }, h.session.id);
  await entered.promise;
  await detach();
  h.close();

  const reopened = h.open();
  const pending = await reopened.feedback.read(owner, key);
  expect(pending).toMatchObject({ receipt, feedback: { status: "pending" } });
  release.resolve();
  const turn = await waitForTerminal(h);
  expect(pending?.feedback).toMatchObject({ turnId: turn.id });
  expect(await reopened.feedback.read(owner, key)).toMatchObject({ receipt, feedback: { status: "completed", turnId: turn.id } });
  expect(reopened.records.counts()).toEqual(oneRecord);
  expect(h.vendor.ioSnapshot.requests).toBe(1);
});

it("AC07 a failed publication recovers the original final item without resending", async (context) => {
  const h = await fixture(context);
  const receipt = h.records.commit(owner, drink);
  await h.feedback.start(owner, key, { requested: true }, h.session.id);
  const turn = await waitForTerminal(h);
  const items = await h.store.listItems(h.session.id, { turnId: turn.id, limit: 20 });
  const final = items.find((item) => item.type === "agentMessage" && item.status === "completed");
  expect(final).toBeDefined();
  const db = new DatabaseSync(h.feedbackPath);
  try {
    db.exec(`CREATE TRIGGER fixture_fail_publish BEFORE UPDATE ON feedback
      WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture publication failed'); END;`);
    expect(await h.feedback.read(owner, key)).toMatchObject({ receipt, feedback: { status: "pending", turnId: turn.id } });
    db.exec("DROP TRIGGER fixture_fail_publish");
  } finally {
    db.close();
  }
  h.close();
  const reopened = h.open();
  expect(await reopened.feedback.read(owner, key)).toMatchObject({
    receipt, feedback: { status: "completed", turnId: turn.id, itemId: final?.id },
  });
  expect(reopened.records.counts()).toEqual(oneRecord);
  expect(h.vendor.ioSnapshot.requests).toBe(1);
});

it("AC07 a max_steps terminal turn never publishes its partial reply", async (context) => {
  const h = await fixture(context, { maxSteps: 1, reply: { text: "部分内容" } });
  const receipt = h.records.commit(owner, drink);
  await h.feedback.start(owner, key, { requested: true }, h.session.id);
  const turn = await waitForTerminal(h);
  expect(turn).toMatchObject({ status: "completed", stopReason: "max_steps" });
  const result = await h.feedback.read(owner, key);
  expect(result).toMatchObject({ receipt, feedback: { status: "failed", turnId: turn.id } });
  expect(result?.feedback).not.toHaveProperty("text");
  expect(h.records.counts()).toEqual(oneRecord);
  expect(h.vendor.ioSnapshot.requests).toBe(1);
});

it("AC07 an unknown reservation is kept pending on replay without a new turn", async (context) => {
  const h = await fixture(context);
  const reserve = h.host.beginTurn.bind(h.host);
  const begin = vi.spyOn(h.host, "beginTurn").mockImplementationOnce(async (...args) => {
    await reserve(...args);
    throw new Error("Fixture lost the reservation response");
  });
  const receipt = h.records.commit(owner, drink);
  const pending = await h.feedback.start(owner, key, { requested: true }, h.session.id);
  expect(pending).toMatchObject({ receipt, feedback: { status: "pending", turnId: null } });
  h.close();
  const reopened = h.open();
  expect(await reopened.feedback.read(owner, key)).toEqual(pending);
  expect(await reopened.feedback.start(owner, key, { requested: true }, h.session.id)).toEqual(pending);
  expect(begin).toHaveBeenCalledOnce();
  expect((await h.store.listTurns(h.session.id, { limit: 10 })).data).toHaveLength(1);
  expect(reopened.records.counts()).toEqual(oneRecord);
  expect(h.vendor.ioSnapshot.requests).toBe(0);
});

it("AC07 a reserved turn is interrupted if its binding cannot be persisted", async (context) => {
  const h = await fixture(context);
  const receipt = h.records.commit(owner, drink);
  const db = new DatabaseSync(h.feedbackPath);
  try {
    db.exec(`CREATE TRIGGER fixture_fail_bind BEFORE UPDATE OF turn_id ON feedback
      BEGIN SELECT RAISE(ABORT, 'fixture binding failed'); END;`);
    expect(await h.feedback.start(owner, key, { requested: true }, h.session.id)).toMatchObject({
      receipt, feedback: { status: "pending", turnId: null },
    });
  } finally {
    db.close();
  }
  expect(await waitForTerminal(h)).toMatchObject({ status: "interrupted", stopReason: "interrupted" });
  expect(await h.feedback.read(owner, key)).toMatchObject({ receipt, feedback: { status: "pending" } });
  expect(h.records.lookupReceipt(owner, key)).toEqual(receipt);
  expect(h.records.counts()).toEqual(oneRecord);
  expect(h.vendor.ioSnapshot.requests).toBe(0);
});
