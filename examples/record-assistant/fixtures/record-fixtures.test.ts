import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import {
  FakeMemoryReceiver,
  FakeRecordService,
  type CommitReceipt,
  type ConfirmedDrink,
} from "./record-fixtures.ts";

const owner = { tenantId: "fixture-tenant", ownerId: "fixture-self" };
const stream = { streamId: "fixture-records", initialSequence: 10 };
const drink: ConfirmedDrink = {
  clientOperationId: "drink-1",
  occurredAt: "2026-11-24T14:30:00-08:00",
  timeZone: "America/Los_Angeles",
  value: "300",
  unit: "ml",
  beverageKind: "water",
};
const { clientOperationId, ...drinkFields } = drink;
const none = { records: 0, receipts: 0, outbox: 0 };
const one = { records: 1, receipts: 1, outbox: 1 };
const incomplete = { clientOperationId: "drink-missing-amount", rawInput: "喝了水" };

function environment(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "diandi-record-fixture-"));
  const recordsPath = join(dir, "records.sqlite");
  const memoryPath = join(dir, "memory.sqlite");
  const resources: Array<{ close(): void }> = [];
  t.after(() => {
    for (const resource of resources.reverse()) resource.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    recordsPath,
    memoryPath,
    openRecords() {
      const records = new FakeRecordService(recordsPath, stream);
      resources.push(records);
      return records;
    },
    openMemory() {
      const memory = new FakeMemoryReceiver(memoryPath, stream);
      resources.push(memory);
      return memory;
    },
  };
}

function storedMemoryOperation(path: string, eventId: string): string {
  const audit = new DatabaseSync(path, { readOnly: true });
  try {
    const operationId = audit.prepare("SELECT operation_id FROM inbox WHERE event_id = ?").get(eventId)?.operation_id;
    assert.ok(typeof operationId === "string");
    return operationId;
  } finally {
    audit.close();
  }
}

function startCommit(path: string, fault?: "beforeCommit" | "afterCommit") {
  // Each process opens its own SQLite connection and waits for the parent to release it.
  const program = `
    const { FakeRecordService } = await import(process.argv[1]);
    const { path, stream, owner, drink, fault } = JSON.parse(process.argv[2]);
    const records = new FakeRecordService(path, stream);
    process.once("message", () => {
      const receipt = records.commit(owner, drink, (phase) => {
        if (phase === fault) process.kill(process.pid, "SIGKILL");
      });
      process.stdout.write(JSON.stringify(receipt));
      records.close();
      process.disconnect();
    });
    process.send("ready");
  `;
  const moduleUrl = new URL("./record-fixtures.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program, moduleUrl,
    JSON.stringify({ path, stream, owner, drink, fault })], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("close", () => reject(new Error(`Commit process exited before ready: ${stderr}`)));
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  return { ready, release: () => child.send("commit"), result };
}

test("AC01 saves one confirmed drink and reads the same receipt after restart", (t) => {
  const env = environment(t);
  const writer = env.openRecords();
  assert.deepEqual(writer.counts(), none);
  const receipt = writer.commit(owner, drink);
  assert.deepEqual(receipt, {
    status: "committed",
    operationId: receipt.operationId,
    actionId: receipt.actionId,
    recordId: receipt.recordId,
    recordVersion: 1,
  });
  assert.ok(receipt.operationId && receipt.actionId && receipt.recordId);
  writer.close();

  const records = env.openRecords();
  assert.deepEqual(records.lookupReceipt(owner, clientOperationId), receipt);
  assert.deepEqual(records.readRecord(owner, receipt.recordId), {
    recordId: receipt.recordId,
    recordVersion: 1,
    ...drinkFields,
  });
  assert.deepEqual(records.counts(), one);
  const [delivery] = records.listOutbox();
  assert.ok(delivery);
  assert.equal(delivery.event.sequence, 11);
  assert.equal(delivery.memoryStatus, "pending");
  assert.equal(delivery.event.payload.externalRecordRef.recordId, receipt.recordId);
});

test("AC03 recovers the exact pending input from a new process without saving a record", (t) => {
  const env = environment(t);
  const program = `
    const { FakeRecordService } = await import(process.argv[1]);
    const { path, stream, owner, incomplete } = JSON.parse(process.argv[2]);
    const records = new FakeRecordService(path, stream);
    process.stdout.write(JSON.stringify(records.forOwner(owner).retainIncompleteDrink(incomplete)));
    records.close();
  `;
  const moduleUrl = new URL("./record-fixtures.ts", import.meta.url).href;
  const written = spawnSync(process.execPath, ["--input-type=module", "--eval", program, moduleUrl,
    JSON.stringify({ path: env.recordsPath, stream, owner, incomplete })], { encoding: "utf8", timeout: 10_000 });
  assert.equal(written.status, 0, written.stderr);
  const received = JSON.parse(written.stdout);
  assert.ok(typeof received.operationId === "string" && received.operationId.length > 0);
  assert.deepEqual(received, {
    operationId: received.operationId, status: "pending_input", rawInput: "喝了水", missingFields: ["amount"],
  });

  const records = env.openRecords();
  const caller = records.forOwner(owner);
  assert.deepEqual(caller.lookupOperation(incomplete.clientOperationId), received);
  assert.equal(caller.lookupReceipt(incomplete.clientOperationId), null);
  assert.deepEqual(caller.retainIncompleteDrink(incomplete), received);
  assert.throws(() => caller.retainIncompleteDrink({ ...incomplete, rawInput: "刚刚喝了水" }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.throws(() => caller.commit({ ...drink, clientOperationId: incomplete.clientOperationId }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.deepEqual(records.counts(), none);
  assert.deepEqual(records.listOutbox(), []);
  assert.deepEqual(caller.lookupOperation(incomplete.clientOperationId), received);

  const receipt = caller.commit(drink);
  assert.deepEqual(caller.lookupOperation(clientOperationId), receipt);
  assert.equal(records.listOutbox()[0]?.event.sequence, 11);
  assert.throws(() => caller.retainIncompleteDrink({ ...incomplete, clientOperationId }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.deepEqual(records.counts(), one);
});

test("AC08 fixture isolates two owners and rejects caller-supplied authority", (t) => {
  const env = environment(t);
  const writer = env.openRecords();
  const alice = writer.forOwner(owner);
  const pending = alice.retainIncompleteDrink(incomplete);
  const receipt = alice.commit(drink);
  writer.close();

  const records = env.openRecords();
  const otherOwner = { ...owner, ownerId: "fixture-other" };
  const bob = records.forOwner(otherOwner);
  assert.equal(bob.lookupOperation(incomplete.clientOperationId), null);
  assert.equal(bob.lookupOperation(clientOperationId), null);
  assert.equal(bob.lookupOperation("absent"), null);
  assert.equal(bob.lookupReceipt(clientOperationId), null);
  assert.equal(bob.readRecord(receipt.recordId), null);
  assert.equal(bob.readRecord("absent"), null);

  const originalOutbox = records.listOutbox();
  for (const claim of [{ ownerId: owner.ownerId }, { tenantId: owner.tenantId },
    { recordId: receipt.recordId }, { grant: "fixture-alice-grant" }, { authorityKind: "external_committed" }]) {
    assert.throws(() => bob.retainIncompleteDrink({ ...incomplete, ...claim }), { code: "UNTRUSTED_FIELD" });
    assert.throws(() => bob.commit({ ...drink, ...claim }), { code: "UNTRUSTED_FIELD" });
  }
  assert.equal(bob.lookupOperation(incomplete.clientOperationId), null);
  assert.equal(bob.lookupOperation(clientOperationId), null);
  assert.deepEqual(records.counts(), one);
  assert.deepEqual(records.listOutbox(), originalOutbox);

  // A client key names an operation for its own owner only.
  const bobPending = bob.retainIncompleteDrink({ ...incomplete, rawInput: "喝了点水" });
  const bobReceipt = bob.commit(drink);
  assert.notEqual(bobPending.operationId, pending.operationId);
  assert.notEqual(bobReceipt.recordId, receipt.recordId);
  const aliceAgain = records.forOwner(owner);
  assert.deepEqual(aliceAgain.lookupOperation(incomplete.clientOperationId), pending);
  assert.deepEqual(aliceAgain.lookupReceipt(clientOperationId), receipt);
  assert.equal(aliceAgain.readRecord(bobReceipt.recordId), null);
  assert.deepEqual(bob.lookupOperation(incomplete.clientOperationId), bobPending);
  assert.equal(records.listOutbox()[1]?.event.payload.ownerId, otherOwner.ownerId);
});

test("AC04 concurrent submissions and exact retries share one receipt, record and event", async (t) => {
  const env = environment(t);
  const initial = env.openRecords();
  initial.close();
  const first = startCommit(env.recordsPath, "afterCommit");
  const second = startCommit(env.recordsPath, "afterCommit");
  await Promise.all([first.ready, second.ready]);
  first.release();
  second.release();
  const results = await Promise.all([first.result, second.result]);
  // One process commits then loses its response. The other observes the same durable operation.
  assert.equal(results.filter((result) => result.signal === "SIGKILL" && result.stdout === "").length, 1);
  const response = results.find((result) => result.code === 0);
  assert.ok(response, JSON.stringify(results));
  const receipt: CommitReceipt = JSON.parse(response.stdout);

  const callerRestarted = env.openRecords();
  assert.deepEqual(callerRestarted.lookupReceipt(owner, clientOperationId), receipt);
  const originalDeliveries = callerRestarted.listOutbox();
  assert.deepEqual(callerRestarted.commit(owner, { ...drinkFields, clientOperationId }), receipt);
  assert.deepEqual(callerRestarted.counts(), one);
  assert.throws(() => callerRestarted.commit(owner, { ...drink, value: "350" }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(callerRestarted.lookupReceipt(owner, clientOperationId), receipt);
  assert.equal(callerRestarted.readRecord(owner, receipt.recordId)?.value, "300");
  assert.deepEqual(callerRestarted.listOutbox(), originalDeliveries);

  const fresh = callerRestarted.commit(owner, { ...drink, clientOperationId: "drink-2" });
  assert.notEqual(fresh.recordId, receipt.recordId);
  assert.notEqual(fresh.actionId, receipt.actionId);
  assert.notEqual(fresh.operationId, receipt.operationId);
  const [firstEvent, nextEvent] = callerRestarted.listOutbox().map((row) => row.event);
  assert.ok(firstEvent && nextEvent);
  assert.notEqual(nextEvent.payload.sourceGroupId, firstEvent.payload.sourceGroupId);
  assert.notEqual(nextEvent.eventId, firstEvent.eventId);
  assert.equal(nextEvent.sequence, 12);
  assert.deepEqual(callerRestarted.counts(), { records: 2, receipts: 2, outbox: 2 });
});

test("AC09 process exit before commit rolls back all writes; exit after commit leaves all three durable", async (t) => {
  for (const phase of ["beforeCommit", "afterCommit"] as const) {
    await t.test(phase, async (scenario) => {
      const env = environment(scenario);
      const initial = env.openRecords();
      initial.close();
      const process = startCommit(env.recordsPath, phase);
      await process.ready;
      process.release();
      const result = await process.result;
      assert.equal(result.signal, "SIGKILL", result.stderr);
      assert.equal(result.stdout, "");

      const reopened = env.openRecords();
      const recovered = reopened.lookupReceipt(owner, clientOperationId);
      if (phase === "beforeCommit") {
        assert.equal(recovered, null);
        assert.deepEqual(reopened.counts(), none);
        assert.deepEqual(reopened.listOutbox(), []);
      } else {
        assert.ok(recovered);
        assert.deepEqual(reopened.counts(), one);
        assert.equal(reopened.readRecord(owner, recovered.recordId)?.value, "300");
      }
      const durableOutbox = reopened.listOutbox();
      const receipt = reopened.commit(owner, drink);
      const [outbox] = reopened.listOutbox();
      assert.ok(outbox);
      assert.equal(outbox.event.sequence, 11);
      assert.equal(outbox.event.streamId, stream.streamId);
      assert.equal(outbox.event.payload.externalRecordRef.recordId, receipt.recordId);
      assert.equal(outbox.event.payloadHash, createHash("sha256").update(JSON.stringify(outbox.event.payload)).digest("hex"));
      assert.deepEqual(reopened.counts(), one);
      if (phase === "afterCommit") {
        assert.deepEqual(receipt, recovered);
        assert.deepEqual(reopened.listOutbox(), durableOutbox);
      }
    });
  }
});

test("AC05 saves offline and redelivers the same event, then waits for application", async (t) => {
  for (const dropAcceptedResponse of [false, true]) {
    await t.test(dropAcceptedResponse ? "accept response lost" : "accept before apply", (scenario) => {
      const env = environment(scenario);
      const records = env.openRecords();
      const receiver = env.openMemory();
      receiver.setOnline(false);
      const receipt = records.commit(owner, drink);
      assert.deepEqual(records.lookupReceipt(owner, clientOperationId), receipt);
      assert.equal(records.dispatchNext(receiver)?.memoryStatus, "pending");
      const [original] = records.listOutbox();
      assert.ok(original);
      assert.equal(original.memoryOperationId, null);
      assert.deepEqual(receiver.snapshot(), { inbox: 0, applied: 0, throughSequence: 10 });
      records.close();
      receiver.close();

      const dispatcher = env.openRecords();
      let memory = env.openMemory();
      let operationBeforeResponseLoss: string | undefined;
      assert.deepEqual(dispatcher.listOutbox(), [original]);
      if (dropAcceptedResponse) {
        memory.dropNextAcceptanceResponse();
        assert.deepEqual(dispatcher.dispatchNext(memory), original);
        assert.deepEqual(memory.snapshot(), { inbox: 1, applied: 0, throughSequence: 10 });
        memory.close();
        operationBeforeResponseLoss = storedMemoryOperation(env.memoryPath, original.event.eventId);
        memory = env.openMemory();
      }
      const accepted = dispatcher.dispatchNext(memory);
      assert.ok(accepted?.memoryOperationId);
      assert.deepEqual(accepted.event, original.event);
      assert.equal(accepted.memoryStatus, "pending");
      if (operationBeforeResponseLoss) assert.equal(accepted.memoryOperationId, operationBeforeResponseLoss);
      assert.deepEqual(memory.snapshot(), { inbox: 1, applied: 0, throughSequence: 10 });
      dispatcher.close();
      const restarted = env.openRecords();
      const lookupOnly = {
        receive() { return assert.fail("An acknowledged operation must be polled by its original ID"); },
        lookupOperation(operationId: string) {
          assert.equal(operationId, accepted.memoryOperationId);
          return memory.lookupOperation(operationId);
        },
      };
      assert.deepEqual(restarted.dispatchNext(lookupOnly), accepted);
      assert.deepEqual(restarted.lookupReceipt(owner, clientOperationId), receipt);

      assert.deepEqual(memory.applyNext(), original.event);
      assert.equal(memory.applyNext(), null);
      memory.close();
      memory = env.openMemory();
      assert.deepEqual(restarted.dispatchNext(lookupOnly), { ...accepted, memoryStatus: "applied" });
      assert.equal(restarted.dispatchNext(lookupOnly), null);
      assert.deepEqual(restarted.counts(), one);
      assert.deepEqual(restarted.lookupReceipt(owner, clientOperationId), receipt);
      assert.deepEqual(memory.receive(original.event), {
        operationId: accepted.memoryOperationId,
        eventId: original.event.eventId,
        status: "applied",
      });
      assert.deepEqual(memory.snapshot(), { inbox: 1, applied: 1, throughSequence: 11 });
    });
  }
});
