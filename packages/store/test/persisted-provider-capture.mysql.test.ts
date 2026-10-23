import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyUsage, type Item, type Turn } from "@agent-service/protocol";
import { EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256, MysqlSessionStore, PersistedProviderCaptureIntegrityError, newErasureRequestId, tenantTelemetryWriteAdapterResult, userErasureRequestHash, type CommitBatch, type RetentionPolicyDocumentV1 } from "../src/index.js";
import { mkSession, newId } from "./conformance.js";
import { activateCurrentCaptureFixture as activateCaptureFixture, captureRefKey, captureCurrentStepFixture as captureStepFixture } from "./persisted-provider-capture.fixture.js";
import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection } from "./fixtures/capture-mysql-runtime.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";
import { MysqlSessionAuthority } from "../src/mysql/session-authority.js";
import { captureSessionAcquireCommand } from "../src/session-authority.js";
import { persistedProviderCaptureCanonicalJson, type CommitPersistedProviderStepFailureInput } from "../src/index.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(name)) {
    throw new Error("MYSQL_TEST_URL must target local disposable MySQL");
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

type Step = Awaited<ReturnType<typeof captureStepFixture>>;
function admitCapture(step:Step,input:CommitPersistedProviderStepFailureInput=step.input){
  return {...input,batch:step.lease.admit({...input.batch})};
}

/** Every assertion below observes real InnoDB rows, not the public read-side usage projection. */
async function snapshot(conn: CaptureMysqlInspection, step: Step) {
  const [session] = await conn.query<RowDataPacket[]>(
    "SELECT * FROM sessions WHERE session_id=?", [step.session.id],
  );
  const [turn] = await conn.query<RowDataPacket[]>(
    "SELECT body FROM turns WHERE turn_id=? AND session_id=?", [step.turn.id, step.session.id],
  );
  const scoped = [
    ["items", "session_id", step.session.id],
    ["events", "session_id", step.session.id],
    ["usage_ledger", "session_id", step.session.id],
    ["billing_usage_facts", "tenant_id", step.session.tenantId],
    ["tenant_telemetry_artifact_inventory", "tenant_id", step.session.tenantId],
    ["tenant_telemetry_write_jobs", "tenant_id", step.session.tenantId],
    ["tenant_telemetry_write_payloads", "tenant_id", step.session.tenantId],
    ["tenant_telemetry_artifact_memberships", "tenant_id", step.session.tenantId],
    ["tenant_telemetry_capture_v2_source_bindings", "tenant_id", step.session.tenantId],
    ["tenant_telemetry_capture_v2_failure_commit_receipts", "tenant_id", step.session.tenantId],
  ] as const;
  const counts: Record<string, number> = {};
  const allRows:Record<string,string[]>={};
  for (const [table, column, value] of scoped) {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`, [value],
    );
    counts[table] = Number(rows[0]?.count);
    const [actual]=await conn.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE ${column}=?`,[value]);
    allRows[table]=actual.map(row=>JSON.stringify(row)).sort();
  }
  return { session: session[0], turn: turn[0], counts, allRows };
}

async function finish(store: MysqlSessionStore, step: Step) {
  const turn: Turn = { ...step.turn, usage: step.batch.turn!.usage, status: "failed", completedAtMs: Date.now(), stopReason: "error" };
  return store.commit(step.lease.admit({
    sessionId: step.session.id, fence: 1, expectedLastSeq: 4, turn,
    events: [
      { type: "error", sessionId: step.session.id, emittedAtMs: turn.completedAtMs!, code: "provider_error", message: "Provider request failed." },
      { type: "turn/completed", sessionId: step.session.id, emittedAtMs: turn.completedAtMs!, turn, stopReason: "error" },
      { type: "session/status/changed", sessionId: step.session.id, emittedAtMs: turn.completedAtMs!, status: { type: "idle" } },
    ],
    sessionPatch: { status: { type: "idle" } },
  }));
}

async function ordinaryDeleteAndSeal(store: MysqlSessionStore, h: Step) {
  const atMs = Date.now();
  await store.commitOrdinarySessionDelete(h.lease.admit({ sessionId: h.session.id, fence: 1, expectedLastSeq: 7,
    lifecycle: { type: "tombstone", tenantId: h.session.tenantId, userId: h.session.userId,
      atMs, purgeAfterMs: null, deletionGeneration: 1 },
    events: [{ type: "session/deleted", sessionId: h.session.id, emittedAtMs: atMs, deletionGeneration: 1 }] }));
  await store.sealOrdinarySessionDeleteGrace(h.session.tenantId, h.session.userId, h.session.id);
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("persisted provider-step capture: real MySQL transaction and isolation", () => {
    let activeOwner:CaptureMysqlRuntimeOwner|undefined,inactiveOwner:CaptureMysqlRuntimeOwner|undefined;
    let conn:CaptureMysqlInspection;
    let first:MysqlSessionStore,second:MysqlSessionStore,inactive:MysqlSessionStore;
    let inactiveConn:CaptureMysqlInspection;
    beforeAll(async()=>{
      const base=disposableBase(BASE_MYSQL_URL).toString();
      activeOwner=new CaptureMysqlRuntimeOwner(base);await activeOwner.prepare();
      await activeOwner.activatePrimary();
      first=await activeOwner.openStore(4);await activateCaptureFixture(first);
      second=await activeOwner.openStore(4);conn=await activeOwner.openInspection();
      inactiveOwner=new CaptureMysqlRuntimeOwner(base);await inactiveOwner.prepare();
      inactive=await inactiveOwner.openStore(2);inactiveConn=await inactiveOwner.openInspection();
    }, 120_000);
    afterAll(async({},suite)=>{
      type Collected={type:string;tasks?:readonly Collected[];result?:{state?:string}};
      const tests:Collected[]=[];const collect=(tasks:readonly Collected[])=>{for(const task of tasks){
        if(task.type==="test")tests.push(task);else if(task.tasks)collect(task.tasks);}};collect(suite.tasks);
      const successful=tests.length>0&&tests.every(test=>test.result?.state==="pass");
      const closed=await Promise.allSettled([activeOwner?.close({successful}),inactiveOwner?.close({successful})]);
      const failed=closed.find((row):row is PromiseRejectedResult=>row.status==="rejected");if(failed)throw failed.reason;
    });

    async function step(options: { empty?: boolean } = {}) {
      return captureStepFixture(first, { tenantId: `tenant-capture-${randomUUID()}`,
        userId: `user-capture-${randomUUID()}`, ...options });
    }

    it.each([false, true])("atomically persists the real failed item (empty=%s), and preserves the two business commits", async (empty) => {
      const h = await step({ empty });
      const result = await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
      expect(result).toMatchObject({ lastSeq: 4, replayed: false,
        failureCommitReceipt: { beginLastSeq: 2, endLastSeq: 4, eventCount: 2, sourceEventSeq: 3 } });
      expect(result.events.map((event) => [event.type, event.seq])).toEqual([["item/completed", 3], ["usage/updated", 4]]);
      expect(await first.getTurn(h.session.id, h.turn.id)).toMatchObject({ status: "inProgress", usage: { totalTokens: 3 } });
      const state = await snapshot(conn, h);
      expect(state.counts).toEqual({ items: 1, events: 4, usage_ledger: 1, billing_usage_facts: 1,
        tenant_telemetry_artifact_inventory: 0, tenant_telemetry_write_jobs: 1,
        tenant_telemetry_write_payloads: 1, tenant_telemetry_artifact_memberships: 1,
        tenant_telemetry_capture_v2_source_bindings: 1, tenant_telemetry_capture_v2_failure_commit_receipts: 1 });
      const [privateRows] = await conn.query<RowDataPacket[]>(
        `SELECT i.telemetry_failure_classification AS item_class,e.telemetry_failure_classification AS event_class,
                i.telemetry_capture_v2_operation_sha256 AS item_op,e.telemetry_capture_v2_operation_sha256 AS event_op,
                b.source_session_ref_sha256,b.source_turn_ref_sha256,b.source_item_ref_sha256,p.payload_json,m.application_binding_receipt_sha256
           FROM items i JOIN events e ON e.session_id=i.session_id AND e.seq=i.seq
           JOIN tenant_telemetry_capture_v2_source_bindings b ON b.write_operation_sha256=i.telemetry_capture_v2_operation_sha256
           JOIN tenant_telemetry_write_payloads p ON p.write_operation_sha256=b.write_operation_sha256
           JOIN tenant_telemetry_artifact_memberships m ON m.write_operation_sha256=b.write_operation_sha256
          WHERE i.item_id=?`, [h.item.id],
      );
      expect(privateRows[0]).toMatchObject({ item_class: "provider_step_error", event_class: "provider_step_error",
        item_op: result.failureCommitReceipt.writeOperationSha256, event_op: result.failureCommitReceipt.writeOperationSha256,
        application_binding_receipt_sha256: null });
      expect(new Set([privateRows[0]!.source_session_ref_sha256, privateRows[0]!.source_turn_ref_sha256, privateRows[0]!.source_item_ref_sha256]).size).toBe(3);
      const payload = JSON.stringify(privateRows[0]!.payload_json);
      for (const forbidden of [h.session.tenantId, h.session.id, h.turn.id, h.item.id, "private partial", "provider\":\"unit", "model\":\"unit"]) expect(payload).not.toContain(forbidden);
      expect(await first.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ status: "source_verified_queued", sourceCount: 1 });
      const terminal = await finish(first, h);
      expect(terminal.events.map((event) => [event.type, event.seq])).toEqual([["error", 5], ["turn/completed", 6], ["session/status/changed", 7]]);
      expect(await first.getTurn(h.session.id, h.turn.id)).toMatchObject({ status: "failed", seqEnd: 7 });
      const [items] = await conn.query<RowDataPacket[]>("SELECT status FROM items WHERE item_id=?", [h.item.id]);
      expect(items[0]?.status).toBe("failed");
      expect(await second.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ sourceCount: 1, status: "source_verified_queued" });
    });

    it("preserves the streamed item start sequence through completion, exact replay and a fresh startup audit", async () => {
      const h = await step();
      const started = structuredClone(h.item);
      started.status = "inProgress";
      delete started.completedAtMs;
      await first.commit(h.lease.admit({ sessionId: h.session.id, fence: 1, expectedLastSeq: 2, items: [started],
        events: [{ type: "item/started", sessionId: h.session.id, emittedAtMs: started.createdAtMs, item: started }] }));
      expect(started.seq).toBe(3);
      h.item.seq = started.seq;
      h.batch.expectedLastSeq = 3;
      const result = await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
      expect(result).toMatchObject({ lastSeq: 5, replayed: false,
        failureCommitReceipt: { beginLastSeq: 3, endLastSeq: 5, sourceEventSeq: 4, eventCount: 2 } });
      expect(result.events.map((event) => [event.type, event.seq])).toEqual([["item/completed", 4], ["usage/updated", 5]]);
      expect((await first.getItem(h.session.id, h.item.id))?.seq).toBe(3);
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT i.seq AS item_seq,JSON_EXTRACT(i.body,'$.seq') AS item_body_seq,
                e.seq AS completion_seq,JSON_EXTRACT(e.body,'$.item.seq') AS completion_item_seq
           FROM items i JOIN events e ON e.session_id=i.session_id
          WHERE i.item_id=? AND e.seq=?`, [h.item.id, result.failureCommitReceipt.sourceEventSeq]);
      expect(Object.fromEntries(Object.entries(rows[0]!).map(([key,value]) => [key,Number(value)])))
        .toEqual({ item_seq: 3, item_body_seq: 3, completion_seq: 4, completion_item_seq: 3 });
      expect(await first.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ sourceCount: 1, status: "source_verified_queued" });
      expect(await first.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).toEqual(result.failureCommitReceipt);
      expect(await first.commitPersistedProviderStepFailure(admitCapture(h, h.input))).toMatchObject({ lastSeq: 5, replayed: true,
        failureCommitReceipt: result.failureCommitReceipt, events: result.events });
      const before = await snapshot(conn, h);
      // Product immutable guards remain installed. A raw row+body sequence rewrite
      // is rejected before it can falsify the sealed completion snapshot.
      for (const seq of [0, 6, 2]) {
        await expect(conn.query("UPDATE items SET seq=?,body=JSON_SET(body,'$.seq',?) WHERE item_id=?", [seq, seq, h.item.id]))
          .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        expect(await snapshot(conn, h)).toEqual(before);
      }
      const fresh = await activeOwner!.openStore(2);
      try {
        expect(await fresh.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ sourceCount: 1, status: "source_verified_queued" });
        expect(await fresh.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).toEqual(result.failureCommitReceipt);
        expect((await fresh.getItem(h.session.id, h.item.id))?.seq).toBe(3);
      } finally { await fresh.close(); }
    });

    it.each(["turns", "billing_usage_facts", "tenant_telemetry_capture_v2_failure_commit_receipts", "sessions"] as const)(
      "rolls back every business/source row and caller cursor after a real late SQL failure at %s", async (table) => {
        const h = await step();
        const before = await snapshot(conn, h);
        const trigger = `capture_fixture_fail_${table.slice(0, 20)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        const event = table === "sessions" || table === "turns" ? "UPDATE" : "INSERT";
        const condition = table === "sessions" ? `NEW.session_id=${mysql.escape(h.session.id)} AND NEW.last_seq>2`
          : table === "turns" ? `NEW.turn_id=${mysql.escape(h.turn.id)}`
            : `NEW.tenant_id=${mysql.escape(h.session.tenantId)}`;
        // Add a fixture-only trigger to an already connected store; do not remove/replace product guards.
        await conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE ${event} ON ${table} FOR EACH ROW BEGIN IF ${condition} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture fixture late rollback'; END IF; END`);
        try {
          await expect(first.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlMessage: "capture fixture late rollback" });
          expect(await snapshot(conn, h)).toEqual(before);
          expect(h.item.seq).toBe(0);
          expect(h.batch.items![0]!.seq).toBe(0);
          expect(h.batch.turn!.seqEnd).toBeUndefined();
          expect(await first.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ status: "not_found", sourceCount: 0 });
        } finally {
          await conn.query(`DROP TRIGGER \`${trigger}\``);
        }
        // Same original input is reusable only because the whole failed transaction rolled back.
        expect(await second.commitPersistedProviderStepFailure(admitCapture(h, h.input))).toMatchObject({ replayed: false, lastSeq: 4 });
      },
    );

    it("rejects serialization before any publication and leaves the original prepared input unchanged", async () => {
      const h = await step();
      const before = await snapshot(conn, h);
      const malformed: CommitBatch = { ...h.batch, turn: { ...h.batch.turn!, metadata: { unsupported: 1n } } };
      // Preserve the original JSON/BigInt codec oracle independently. Authority admits only closed
      // plain data, so the real transaction fault is introduced after both actual backend guards.
      expect(()=>persistedProviderCaptureCanonicalJson(malformed)).toThrow(TypeError);
      const originalPrepared=structuredClone(h.batch),authority=first.sessionAuthority;
      if(!(authority instanceof MysqlSessionAuthority))throw Error("fixture_mysql_authority_required");
      const validate=authority.assertWrite.bind(authority);let validated=0,injected=false;
      const guard=vi.spyOn(authority,"assertWrite").mockImplementation(async(connection,value,scope,proof)=>{
        const result=await validate(connection,value,scope,proof);
        if(scope.sessionId===h.session.id){validated++;if(validated===2){
          const captured=value as CommitBatch;expect(captured).not.toBe(h.batch);
          captured.turn!.metadata={unsupported:1n};injected=true;
        }}return result;
      });
      try {
        const pending=first.commitPersistedProviderStepFailure(admitCapture(h,h.input));
        await expect(pending).rejects.toBeInstanceOf(TypeError);
        await expect(pending).rejects.toThrow(/serialize a BigInt/);
        expect({validated,injected}).toEqual({validated:2,injected:true});
      } finally { guard.mockRestore(); }
      expect(h.batch).toEqual(originalPrepared);
      expect(await snapshot(conn, h)).toEqual(before);
      expect(h.item.seq).toBe(0);
      expect(await second.commitPersistedProviderStepFailure(admitCapture(h, h.input))).toMatchObject({ lastSeq: 4, replayed: false });
    });

    it("reaches the final sequence closure guard after a legal late job transition and rolls back the entire source/business transaction", async () => {
      const h = await step();
      const before = await snapshot(conn, h);
      const target = first as unknown as { insertPersistedFailureWriteSet(connection: PoolConnection, set: unknown): Promise<void> };
      const insert = target.insertPersistedFailureWriteSet.bind(first);
      let legalTransitionCompleted = false;
      const hook = vi.spyOn(target, "insertPersistedFailureWriteSet").mockImplementationOnce(async (connection, set) => {
        await insert(connection, set); // Source/billing/member/job/payload/receipt guards all passed.
        const operation = (set as { job: { writeOperationSha256: string } }).job.writeOperationSha256;
        const [changed] = await connection.query<mysql.ResultSetHeader>(`UPDATE tenant_telemetry_write_jobs
          SET phase='blocked',available_at_ms=NULL,claim_token=NULL,lease_until_ms=NULL,last_error_code=NULL,
              blocked_at_db_ms=created_at_ms,blocked_reason_code='integrity_conflict'
          WHERE write_operation_sha256=?`, [operation]);
        expect(changed.affectedRows).toBe(1);
        legalTransitionCompleted = true;
      });
      try {
        await expect(first.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION",
          sqlMessage: "provider failure source closure is incomplete at sequence publication" });
        expect(legalTransitionCompleted).toBe(true); // Not an earlier CHECK/INSERT/transition guard.
        expect(await snapshot(conn, h)).toEqual(before);
        expect(h.item.seq).toBe(0);
        expect(await second.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ status: "not_found", sourceCount: 0 });
      } finally { hook.mockRestore(); }
      expect(await second.commitPersistedProviderStepFailure(admitCapture(h, h.input))).toMatchObject({ replayed: false, lastSeq: 4 });
    });

    it.each(["before-commit", "after-commit"] as const)("survives actual SIGKILL at %s without a partial failed-step commit or duplicate replay", async (window) => {
      const h = await step();
      const before = await snapshot(conn, h);
      const child = fork(new URL("./fixtures/persisted-provider-capture-crash-driver.ts", import.meta.url), [], {
        execPath: process.execPath, execArgv: ["--import", "tsx"],
        env: { PATH: process.env.PATH ?? "", HOME:process.env.HOME??"", TMPDIR:process.env.TMPDIR??"",
          TMP:process.env.TMP??"",TEMP:process.env.TEMP??"",CI: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let emittedOutput = false;
      child.stdout?.on("data", () => { emittedOutput = true; });
      child.stderr?.on("data", () => { emittedOutput = true; });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
        child.once("error", () => {}); // Only actual close, including stdio, settles the owned process.
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("capture child window deadline")), 30_000);
          child.once("error", () => reject(new Error("capture child process failed")));
          child.once("exit", () => reject(new Error("capture child exited before kill window")));
          child.on("message", (value) => {
            const message = value as { phase?: string; window?: string; cursorUpdated?: boolean; exactFailureReceipt?: boolean };
            if (message.phase === "driver-ready") child.send({ protocol: "persisted-provider-capture-crash-fixture-v1",
              window, batch: h.batch, source: h.input.source, runtimeEnv:activeOwner!.runtimeEnv(),
              authorityCommand:captureSessionAcquireCommand(h.lease.command) }, (error) => { if (error) reject(new Error("capture child IPC failed")); });
            if (message.phase === "driver-failed") reject(new Error("capture child failed before kill window"));
            if (message.phase === "capture-window" && message.window === window) {
              if (window === "before-commit" && (message.cursorUpdated !== true || message.exactFailureReceipt !== true)) {
                reject(new Error("capture child has not reached the complete uncommitted write set"));
              } else resolve();
            }
          });
        });
        clearTimeout(timer);
        // Scope is exactly the child this fixture created, never a process search or broad signal.
        expect(child.kill("SIGKILL")).toBe(true);
        expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
        expect(emittedOutput).toBe(false);
        if (window === "before-commit") {
          // A consistent read alone could merely hide a still-open transaction. This real
          // locking read cannot complete until the dead child's row lock is released/rolled back.
          await conn.query("START TRANSACTION");
          try {
            const [locked] = await conn.query<RowDataPacket[]>("SELECT last_seq,fence_token FROM sessions WHERE session_id=? FOR UPDATE", [h.session.id]);
            expect(locked[0]).toMatchObject({ last_seq: 2, fence_token: 1 });
          } finally { await conn.query("ROLLBACK"); }
          const deadline = Date.now() + 5_000;
          let rolledBack = await snapshot(conn, h);
          while (JSON.stringify(rolledBack) !== JSON.stringify(before) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            rolledBack = await snapshot(conn, h);
          }
          expect(rolledBack).toEqual(before);
          expect(h.item.seq).toBe(0);
          expect(await second.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ status: "not_found", sourceCount: 0 });
          const retry = await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
          expect(retry).toMatchObject({ replayed: false, lastSeq: 4 });
          const committed = await snapshot(conn, h);
          const replay = await second.commitPersistedProviderStepFailure(admitCapture(h, h.input));
          expect(replay).toEqual({ ...retry, replayed: true });
          expect(await snapshot(conn, h)).toEqual(committed);
        } else {
          const committed = await snapshot(conn, h);
          expect(committed.session).toMatchObject({ last_seq: 4, fence_token: 1 });
          for (const table of ["items", "usage_ledger", "billing_usage_facts", "tenant_telemetry_write_jobs", "tenant_telemetry_write_payloads",
            "tenant_telemetry_artifact_memberships", "tenant_telemetry_capture_v2_source_bindings", "tenant_telemetry_capture_v2_failure_commit_receipts"]) {
            expect(committed.counts[table]).toBe(1);
          }
          const replay = await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
          expect(replay).toMatchObject({ replayed: true, lastSeq: 4, failureCommitReceipt: { beginLastSeq: 2, endLastSeq: 4 } });
          expect(await snapshot(conn, h)).toEqual(committed);
          expect(await second.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ status: "source_verified_queued", sourceCount: 1 });
        }
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    }, 60_000);

    it("linearizes independent connections' exact retries, then replays the original range after response loss and finish", async () => {
      const h = await step();
      const results = await Promise.all([first.commitPersistedProviderStepFailure(admitCapture(h, h.input)), second.commitPersistedProviderStepFailure(admitCapture(h, h.input))]);
      expect(results.map((value) => value.replayed).sort()).toEqual([false, true]);
      expect(results[0]!.failureCommitReceipt).toEqual(results[1]!.failureCommitReceipt);
      expect(results[0]!.events).toEqual(results[1]!.events);
      // Discarding an already committed reply is a deterministic response-loss oracle, not a socket-loss claim.
      await finish(first, h);
      const replay = await second.commitPersistedProviderStepFailure(admitCapture(h, h.input));
      expect(replay).toEqual({ ...results[0]!, replayed: true });
      expect(replay.lastSeq).toBe(4);
      expect(await first.getSession(h.session.tenantId, h.session.id)).toMatchObject({ lastSeq: 7, fenceToken: 1 });
      const state = await snapshot(conn, h);
      expect(state.counts.usage_ledger).toBe(1);
      expect(state.counts.billing_usage_facts).toBe(1);
      expect(state.counts.tenant_telemetry_capture_v2_failure_commit_receipts).toBe(1);
    });

    it("does not let another item race into the same source step", async () => {
      const h = await step();
      const batch = structuredClone(h.batch);
      const itemId = newId("item");
      batch.items![0]!.id = itemId;
      const completed = batch.events![0]!;
      if (completed.type !== "item/completed") throw new Error("fixture completion missing");
      completed.item.id = itemId;
      const outcomes = await Promise.allSettled([
        first.commitPersistedProviderStepFailure(admitCapture(h, h.input)),
        second.commitPersistedProviderStepFailure(admitCapture(h, { ...h.input, batch, source: { ...h.input.source, itemId } })),
      ]);
      expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
      const state = await snapshot(conn, h);
      expect(state.session).toMatchObject({ last_seq: 4, fence_token: 1 });
      for (const table of ["items", "usage_ledger", "billing_usage_facts", "tenant_telemetry_capture_v2_source_bindings",
        "tenant_telemetry_capture_v2_failure_commit_receipts", "tenant_telemetry_write_jobs", "tenant_telemetry_write_payloads", "tenant_telemetry_artifact_memberships"]) expect(state.counts[table]).toBe(1);
    });

    it("keeps generic runtime failure unknown, immutable, and impossible to upgrade into a provider source", async () => {
      const h = await step();
      const activation = await first.getTenantTelemetryPersistedProviderCaptureActivationReceipt();
      // Caller time is not a cutover classifier: a post-cutover unknown can be backdated.
      h.item.createdAtMs = 1; h.item.completedAtMs = 1;
      for (const event of h.batch.events!) event.emittedAtMs = 1;
      h.batch.usageEntries![0]!.createdAtMs = 1;
      await first.commit(h.lease.admit({...h.batch}));
      const before = await snapshot(conn, h);
      const [rows] = await conn.query<RowDataPacket[]>("SELECT telemetry_failure_classification,telemetry_capture_v2_operation_sha256,telemetry_capture_v2_control_generation FROM items WHERE item_id=?", [h.item.id]);
      expect(rows[0]).toMatchObject({ telemetry_failure_classification: "runtime_unknown", telemetry_capture_v2_operation_sha256: null, telemetry_capture_v2_control_generation: 1 });
      expect(await first.getTenantTelemetryPersistedProviderCaptureActivationReceipt()).toEqual(activation);
      await expect(second.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toThrow();
      expect(await snapshot(conn, h)).toEqual(before);
      expect(await first.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ status: "not_found", sourceCount: 0 });
      await expect(conn.query("UPDATE items SET telemetry_failure_classification=NULL WHERE item_id=?", [h.item.id])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
    });

    it("isolates tenant/user/source ownership and all fresh tuple fields before any write", async () => {
      const h = await step();
      const other = await step();
      const before = await snapshot(conn, h);
      for (const source of [
        { ...h.input.source, tenantId: other.session.tenantId },
        { ...h.input.source, userId: other.session.userId },
        { ...h.input.source, turnId: other.turn.id },
        { ...h.input.source, itemId: other.item.id },
      ]) await expect(second.commitPersistedProviderStepFailure(admitCapture(h, { ...h.input, source }))).rejects.toThrow();
      for (const key of ["runtimeEpochSha256", "runtimeBindingSha256", "logsTargetSha256", "logsTargetReceiptSha256", "refKeyIdSha256", "captureControlEvidenceSha256", "configuredFleetRootSha256"] as const) {
        await expect(second.commitPersistedProviderStepFailure(admitCapture(h, { ...h.input, freshProof: { ...h.proof, [key]: "9".repeat(64) } }))).rejects.toThrow();
      }
      expect(await snapshot(conn, h)).toEqual(before);
      const result = await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
      expect(await second.getSession(other.session.tenantId, h.session.id)).toBeNull();
      expect(await second.getSessionLifecycle(h.session.tenantId, other.session.userId, h.session.id)).toBeNull();
      expect(await second.verifyPersistedProviderStepFailureSource({ ...h.lookup, tenantId: other.session.tenantId })).toMatchObject({ status: "not_found", sourceCount: 0 });
      expect(await second.getTenantTelemetryPersistedProviderCaptureSourceBinding(other.session.tenantId, result.failureCommitReceipt.writeOperationSha256)).toBeNull();
      await expect(second.verifyPersistedProviderStepFailureWrite(other.session.tenantId, result.failureCommitReceipt.writeOperationSha256, h.proof)).rejects.toThrow();
      await h.lease.release();
      const replacement=await acquireFixtureSessionAuthority(first,h.session,1);
      await first.commit(replacement.admit({ sessionId: h.session.id, fence: 2, fenceClaim: { tenantId: h.session.tenantId, userId: h.session.userId } }));
      await expect(second.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toThrow();
      expect(await first.getSession(h.session.tenantId, h.session.id)).toMatchObject({ lastSeq: 4, fenceToken: 2 });
    });

    it("creates new tenant coverage with the first session, and rolls both back if its first event fails", async () => {
      const session = mkSession(`tenant-capture-creation-${randomUUID()}`, `user-capture-creation-${randomUUID()}`);
      const trigger = `capture_fixture_create_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      await conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON events FOR EACH ROW BEGIN IF NEW.session_id=${mysql.escape(session.id)} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture fixture first event failure'; END IF; END`);
      try {
        await expect(first.createSession(session)).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        for (const [table, column, value] of [
          ["sessions", "session_id", session.id], ["events", "session_id", session.id],
          ["subject_lifecycle", "tenant_id", session.tenantId],
          ["tenant_telemetry_lifecycle_coverages", "tenant_id", session.tenantId],
          ["tenant_telemetry_capture_v2_coverages", "tenant_id", session.tenantId],
        ] as const) {
          const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`, [value]);
          expect(Number(rows[0]?.count)).toBe(0);
        }
        expect(session.lastSeq).toBe(0);
        expect(await first.getTenantTelemetryPersistedProviderCaptureCoverage(session.tenantId)).toBeNull();
      } finally { await conn.query(`DROP TRIGGER \`${trigger}\``); }
      await second.createSession(session);
      expect(await first.getTenantTelemetryPersistedProviderCaptureCoverage(session.tenantId)).toMatchObject({ captureStatus: "capture_since_tenant_creation", preCutoverHistoryStatus: "pre_cutover_not_applicable" });
      const [rows] = await conn.query<RowDataPacket[]>("SELECT telemetry_logs_capture_v2_generation FROM subject_lifecycle WHERE tenant_id=? AND subject_kind='tenant'", [session.tenantId]);
      expect(Number(rows[0]?.telemetry_logs_capture_v2_generation)).toBe(1);
    });

    it("rechecks the real user admission fence without blocking another user in the same tenant", async () => {
      const h = await step();
      const neighbour = await captureStepFixture(first, { tenantId: h.session.tenantId, userId: `neighbour-${randomUUID()}` });
      const before = await snapshot(conn, h);
      await second.requestUserErasure({ requestId: newErasureRequestId(), tenantId: h.session.tenantId,
        userId: h.session.userId, requestedByKeyId: "capture-test-admin", idempotencyKey: `capture-erasure-${randomUUID()}`,
        requestHash: userErasureRequestHash(h.session.tenantId, h.session.userId), atMs: Date.now() });
      await expect(first.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toThrow();
      expect(await snapshot(conn, h)).toEqual(before);
      expect(h.item.seq).toBe(0);
      expect(await first.commitPersistedProviderStepFailure(admitCapture(neighbour, neighbour.input))).toMatchObject({ replayed: false, lastSeq: 4 });
      expect(await second.verifyPersistedProviderStepFailureSource(neighbour.lookup)).toMatchObject({ sourceCount: 1 });
    });

    it("binds activation and new writes to the actual immutable primary runtime epoch", async () => {
      const h = await step();
      const [runtime] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_restore_runtime_control WHERE singleton_id=1");
      expect(runtime[0]).toMatchObject({ state: "active", lineage_kind: "primary", runtime_epoch_sha256: h.proof.runtimeEpochSha256 });
      await expect(conn.query("UPDATE tenant_restore_runtime_control SET runtime_epoch_sha256=? WHERE singleton_id=1", ["9".repeat(64)])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      const [after] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_restore_runtime_control WHERE singleton_id=1");
      expect(after).toEqual(runtime);
      const before = await snapshot(conn, h);
      await expect(first.commitPersistedProviderStepFailure(admitCapture(h, { ...h.input, freshProof: { ...h.proof, runtimeEpochSha256: "9".repeat(64) } }))).rejects.toThrow();
      expect(await snapshot(conn, h)).toEqual(before);
      expect(await second.commitPersistedProviderStepFailure(admitCapture(h, h.input))).toMatchObject({ lastSeq: 4, replayed: false });
    });

    it("uses actual RR for capture/claim/reserve/ACK even when each borrowed session defaults to READ COMMITTED", async () => {
      const h = await step();
      const probeTable=await activeOwner!.createIsolationProbe();
      const pool = (first as unknown as { pool: Pool }).pool;
      let probeId = 0;
      async function withRcProbe<T>(work: () => Promise<T>): Promise<T> {
        const getConnection = pool.getConnection.bind(pool);
        const borrowed=new Set<PoolConnection>(),beginSpies=new Set<ReturnType<typeof vi.spyOn>>();
        let observed = false;
        const acquireSpy = vi.spyOn(pool, "getConnection").mockImplementation(async (...args) => {
          const connection:PoolConnection = await Reflect.apply(getConnection,pool,args); borrowed.add(connection);
          await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
          const begin = connection.beginTransaction.bind(connection);
          const beginSpy = vi.spyOn(connection, "beginTransaction").mockImplementation(async (...args) => {
            await Reflect.apply(begin,connection,args);
            const id = ++probeId;
            const [before] = await connection.query<RowDataPacket[]>(`SELECT id FROM \`${probeTable}\` WHERE id=?`, [id]);
            expect(before).toEqual([]);
            // Real InnoDB reads on the transaction connection and a separate committed writer:
            // RC would see this phantom. @@transaction_isolation alone cannot prove tx override.
            await conn.query(`INSERT INTO \`${probeTable}\` (id) VALUES (?)`, [id]);
            const [after] = await connection.query<RowDataPacket[]>(`SELECT id FROM \`${probeTable}\` WHERE id=?`, [id]);
            expect(after).toEqual([]);
            observed = true;
          });
          beginSpies.add(beginSpy);return connection;
        });
        let failed=false,firstError:unknown,result:T|undefined;
        try { result=await work();expect(observed).toBe(true); }
        catch(error){failed=true;firstError=error;}
        finally {
          for(const spy of beginSpies)spy.mockRestore();acquireSpy.mockRestore();
          // All actual transaction work has committed/rolled back before restoring every
          // checkout wrapper whose real underlying session default was changed.
          const restored=await Promise.allSettled([...borrowed].map(connection=>
            connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")));
          for(const row of restored)if(row.status==="rejected"&&!failed){failed=true;firstError=row.reason;}
        }
        if(failed)throw firstError;return result as T;
      }
      try {
        const result = await withRcProbe(() => first.commitPersistedProviderStepFailure(admitCapture(h, h.input)));
        const claim = (await withRcProbe(() => first.claimTenantTelemetryWriteJobs({ limit: 100, leaseMs: 300_000,
          claimToken: `capture-rc-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: h.proof })))
          .find((value) => value.writeOperationSha256 === result.failureCommitReceipt.writeOperationSha256);
        if (!claim) throw new Error("RC fixture failed to claim exact source");
        const auth = { tenantId: claim.tenantId, writeOperationSha256: claim.writeOperationSha256,
          claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
        expect(await withRcProbe(() => first.reserveTenantTelemetryExternalMutation(auth, claim.target.adapterProtocol, h.proof))).not.toBeNull();
        const input = { writeOperationSha256: claim.writeOperationSha256, target: claim.target, inventory: claim.inventory, payload: claim.payload };
        // This result is a transaction-only fixture, not an assertion of actual external sink IO.
        const adapterResult = tenantTelemetryWriteAdapterResult(claim.target.adapterProtocol, input, "written", false);
        expect(await withRcProbe(() => first.completeTenantTelemetryWrite(auth, adapterResult, h.proof))).not.toBeNull();
        expect(probeId).toBe(4);
        expect(await second.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ status: "source_verified_written", sourceCount: 1 });
      } finally { await activeOwner!.dropIsolationProbe(probeTable); }
    });

    it("rejects a current source usage DELETE even when the deleting RR transaction has a pre-capture read view", async () => {
      const h = await step();
      const cleanup = await activeOwner!.openInspection();
      try {
        await cleanup.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await cleanup.query("START TRANSACTION");
        const [before] = await cleanup.query<RowDataPacket[]>("SELECT usage_id FROM usage_ledger WHERE session_id=?", [h.session.id]);
        expect(before).toEqual([]);
        const result = await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
        // InnoDB DELETE is a current read; the guard must also lock/read the new receipt rather
        // than silently using this transaction's older consistent snapshot.
        await expect(cleanup.query("DELETE FROM usage_ledger WHERE usage_id=?", [h.batch.usageEntries![0]!.usageId]))
          .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlMessage: "persisted provider failure usage source is retained" });
        const [rows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM usage_ledger WHERE session_id=?", [h.session.id]);
        expect(Number(rows[0]?.count)).toBe(1);
        expect(await second.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).toEqual(result.failureCommitReceipt);
        expect(await second.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ status: "source_verified_queued", sourceCount: 1 });
      } finally { await cleanup.query("ROLLBACK"); await cleanup.end(); }
    });

    it("serializes capture with a concurrent real restore preparation and rejects every subsequent capture while the run is pending", async () => {
      const h = await step();
      const journal = await first.getTenantRestoreJournalControl();
      if (journal.controlGeneration !== 1) throw new Error("restore race fixture journal not active");
      const targets = await first.getTenantRestoreJournalControlTargets();
      const restoreRunId = `restore_${randomUUID()}`;
      const before = await snapshot(conn, h);
      try {
        const [capture, prepare] = await Promise.allSettled([
          first.commitPersistedProviderStepFailure(admitCapture(h, h.input)),
          second.prepareTenantRestoreReplay({ restoreRunId, sourceBackupSha256: "7".repeat(64), runtimeEpochSha256: "8".repeat(64),
            controlEvidenceSha256: journal.evidenceSha256, sealedTargets: targets.map((target) => ({ ...target,
              logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256, sealedRemoteSequence: 0,
              sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 })) }),
        ]);
        expect(prepare.status).toBe("fulfilled");
        if (capture.status === "fulfilled") {
          expect(capture.value).toMatchObject({ lastSeq: 4, replayed: false });
          const current = await snapshot(conn, h);
          expect(current.session).toMatchObject({ last_seq: 4, fence_token: 1 });
          expect(current.counts.usage_ledger).toBe(1);
          expect(current.counts.tenant_telemetry_capture_v2_failure_commit_receipts).toBe(1);
        } else {
          // The race may lose to the pending fence or to a genuine InnoDB deadlock. An unrelated
          // closure SIGNAL is never accepted as proof of isolation or classified as a safe loss.
          expect(capture.reason instanceof PersistedProviderCaptureIntegrityError
            || ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes((capture.reason as { code?: string }).code ?? "")).toBe(true);
          expect(await snapshot(conn, h)).toEqual(before);
        }
        const pending = await snapshot(conn, h);
        await expect(first.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toBeInstanceOf(PersistedProviderCaptureIntegrityError);
        await expect(second.getTenantTelemetryPersistedProviderCaptureBinding()).rejects.toBeInstanceOf(PersistedProviderCaptureIntegrityError);
        expect(await snapshot(conn, h)).toEqual(pending);
      } finally {
        // Actual versioned abort preserves the permanent run/epoch history; no guard/control row
        // is deleted, and this SQL fixture does not claim an external restored-head proof.
        await second.abortTenantRestoreReplay(restoreRunId);
      }
      expect(await first.getTenantTelemetryPersistedProviderCaptureBinding()).toEqual(h.proof);
    });

    it("SQL guards reject old-writer failed item/event omission and protect committed source snapshots", async () => {
      const h = await step();
      const item: Item = { ...h.item, seq: 3 };
      await expect(conn.query(
        "INSERT INTO items (item_id,session_id,user_id,turn_id,seq,type,status,body,created_at_ms,completed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [item.id, item.sessionId, h.session.userId, item.turnId, item.seq, item.type, item.status, JSON.stringify(item), item.createdAtMs, item.completedAtMs],
      )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      await first.commit(h.lease.admit({...h.batch}));
      const missingEvent = { type: "item/completed", sessionId: h.session.id, emittedAtMs: Date.now(), seq: 5, item: { ...h.item, seq: 3 } };
      await expect(conn.query("INSERT INTO events (session_id,seq,user_id,type,body,emitted_at_ms) VALUES (?,?,?,?,?,?)",
        [h.session.id, 5, h.session.userId, missingEvent.type, JSON.stringify(missingEvent), missingEvent.emittedAtMs],
      )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      const source = await step();
      await first.commitPersistedProviderStepFailure(admitCapture(source, source.input));
      await expect(conn.query("UPDATE items SET body=JSON_SET(body,'$.text','rewritten') WHERE item_id=?", [source.item.id])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      await expect(conn.query("UPDATE events SET body=JSON_SET(body,'$.item.text','rewritten') WHERE session_id=? AND seq=3", [source.session.id])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      await expect(conn.query("UPDATE tenant_telemetry_capture_v2_failure_commit_receipts SET end_last_seq=end_last_seq+1 WHERE tenant_id=?", [source.session.tenantId])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      expect(await first.verifyPersistedProviderStepFailureSource(source.lookup)).toMatchObject({ sourceCount: 1 });
    });

    it("reads the whole source in one real RR snapshot, then rejects committed operational/billing tampering", async () => {
      const h = await step();
      await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
      const usageId = h.batch.usageEntries![0]!.usageId;
      const pool = (first as unknown as { pool: Pool }).pool;
      const getConnection = pool.getConnection.bind(pool);
      let querySpy: ReturnType<typeof vi.spyOn> | undefined;
      let observedSnapshot = false;
      const acquireSpy = vi.spyOn(pool, "getConnection").mockImplementationOnce(async () => {
        const connection: PoolConnection = await getConnection();
        const query = connection.query.bind(connection);
        querySpy = vi.spyOn(connection, "query").mockImplementation((async (...args: unknown[]) => {
          const result = await Reflect.apply(query, connection, args);
          if (!observedSnapshot && String(args[0]).includes("SELECT write_operation_sha256 FROM tenant_telemetry_capture_v2_failure_commit_receipts")) {
            observedSnapshot = true;
            // This separate connection commits after the verifier snapshot but before its usage read.
            await conn.query("UPDATE usage_ledger SET usage_json=JSON_SET(usage_json,'$.outputTokens',99) WHERE usage_id=?", [usageId]);
          }
          return result;
        }) as PoolConnection["query"]);
        return connection;
      });
      try {
        expect(await first.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ status: "source_verified_queued", sourceCount: 1 });
        expect(observedSnapshot).toBe(true);
        querySpy?.mockRestore(); acquireSpy.mockRestore();
        await expect(second.verifyPersistedProviderStepFailureSource(h.lookup)).rejects.toThrow();
        await conn.query("UPDATE usage_ledger SET usage_json=? WHERE usage_id=?", [JSON.stringify(h.batch.usageEntries![0]!.usage), usageId]);
        await conn.query("UPDATE usage_ledger SET user_id=? WHERE usage_id=?", [`other-user-${randomUUID()}`, usageId]);
        await expect(second.verifyPersistedProviderStepFailureSource(h.lookup)).rejects.toThrow();
      } finally {
        querySpy?.mockRestore(); acquireSpy.mockRestore();
        await conn.query("UPDATE usage_ledger SET usage_json=?,user_id=? WHERE usage_id=?", [JSON.stringify(h.batch.usageEntries![0]!.usage), h.session.userId, usageId]);
      }
      expect(await first.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ sourceCount: 1 });
    });

    it("rejects canonical session/turn owner drift without trusting an unchanged item or source receipt", async () => {
      const h = await step();
      await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
      try {
        // No guard is dropped: a privileged SQL change without cursor advancement is the oracle.
        await conn.query("UPDATE sessions SET user_id=? WHERE session_id=?", [`foreign-session-user-${randomUUID()}`, h.session.id]);
        await expect(second.verifyPersistedProviderStepFailureSource(h.lookup)).rejects.toThrow();
        await conn.query("UPDATE sessions SET user_id=? WHERE session_id=?", [h.session.userId, h.session.id]);
        await conn.query("UPDATE turns SET user_id=? WHERE turn_id=?", [`foreign-turn-user-${randomUUID()}`, h.turn.id]);
        await expect(second.verifyPersistedProviderStepFailureSource(h.lookup)).rejects.toThrow();
      } finally {
        await conn.query("UPDATE sessions SET user_id=? WHERE session_id=?", [h.session.userId, h.session.id]);
        await conn.query("UPDATE turns SET user_id=? WHERE turn_id=?", [h.session.userId, h.turn.id]);
      }
      expect(await first.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ sourceCount: 1, status: "source_verified_queued" });
    });

    it("preserves historical source verification and restart after ordinary DELETE but refuses live capture/reservation", async () => {
      const h = await step();
      const result = await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
      const operation = result.failureCommitReceipt.writeOperationSha256;
      const claim = (await first.claimTenantTelemetryWriteJobs({ limit: 100, leaseMs: 300_000,
        claimToken: `capture-delete-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1",
        captureMode: "include_v2", freshProof: h.proof }))
        .find((value) => value.writeOperationSha256 === operation);
      if (!claim) throw new Error("capture DELETE fixture could not claim its exact source");
      await finish(first, h);
      await ordinaryDeleteAndSeal(first, h);
      expect(await first.getOrdinarySessionDeleteGrace(h.session.tenantId, h.session.userId, h.session.id))
        .toMatchObject({ state: "sealed", executionReady: false, physicalPurgeEnabled: false });
      expect(await first.getSession(h.session.tenantId, h.session.id)).toBeNull();
      expect(await second.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).toEqual(result.failureCommitReceipt);
      expect(await second.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ sourceCount: 1, status: "source_verified_queued", executionReady: false, allDomainsComplete: false });
      const reopened = await activeOwner!.openStore(2);
      try {
        expect(await reopened.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ sourceCount: 1 });
        await expect(reopened.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toThrow();
        await expect(reopened.reserveTenantTelemetryExternalMutation({ writeOperationSha256: claim.writeOperationSha256,
          tenantId: claim.tenantId, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken },
        claim.target.adapterProtocol, h.proof)).resolves.toBeNull();
      } finally { await reopened.close(); }
      expect((await snapshot(conn, h)).session).toMatchObject({ last_seq: 8, fence_token: 1 });
      expect(await first.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).toEqual(result.failureCommitReceipt);
    });

    it("retains source-bound operational usage with an explicit 0052 blocker and a real SQL DELETE guard", async () => {
      const h = await step();
      const day = 86_400_000;
      const policy: RetentionPolicyDocumentV1 = { sessionContentRetentionMs: 30 * day, userErasureGraceMs: 30 * day,
        operationalUsageRetentionMs: 0, idempotencyReceiptRetentionMs: null, billingFactRetentionMs: null,
        lifecycleAuditRetentionMs: null, exportArtifactTtlMs: day };
      await first.putRetentionPolicy({ tenantId: h.session.tenantId, policyVersion: "capture-retention-policy",
        policy, actorKeyId: "capture-test-admin", atMs: Date.now() });
      await first.activateRetentionPolicy({ tenantId: h.session.tenantId, policyVersion: "capture-retention-policy",
        expectedControlGeneration: 0, actorKeyId: "capture-test-admin", atMs: Date.now() });
      await first.commitPersistedProviderStepFailure(admitCapture(h, h.input));
      await finish(first, h); await ordinaryDeleteAndSeal(first, h);
      const owner = { tenantId: h.session.tenantId, userId: h.session.userId, sessionId: h.session.id, deletionGeneration: 1 };
      const reconciliation = await first.reconcileSessionUsage({ ...owner, nowMs: Date.now() });
      const before = await snapshot(conn, h);
      await expect(conn.query("DELETE FROM usage_ledger WHERE usage_id=?", [h.batch.usageEntries![0]!.usageId]))
        .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      // The capture-specific blocker must run before the general active-restore gate/deadline.
      await expect(second.executeOrdinarySessionUsageRetention({ ...owner, expectedChecksum: reconciliation.checksum, enabled: true }))
        .rejects.toThrow("operational usage is retained by sealed provider-step capture");
      expect(await snapshot(conn, h)).toEqual(before);
      const [rows] = await conn.query<RowDataPacket[]>(`SELECT s.ordinary_usage_retention_receipt_json,r.status
        FROM sessions s JOIN usage_reconciliations r ON r.session_id=s.session_id AND r.deletion_generation=1 WHERE s.session_id=?`, [h.session.id]);
      expect(rows[0]).toMatchObject({ ordinary_usage_retention_receipt_json: null, status: "verified" });
      expect(await first.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({ sourceCount: 1 });
    });

    it("preserves both inactive unknown and a real old-writer NULL failure as unknown at activation", async () => {
      const session = mkSession(`tenant-capture-legacy-${randomUUID()}`, `user-capture-legacy-${randomUUID()}`);
      await inactive.createSession(session);
      const inactiveLease=await acquireFixtureSessionAuthority(inactive,session,0);
      const at = Date.now();
      const turn: Turn = { id: newId("turn"), sessionId: session.id, status: "inProgress", seqStart: 2, steps: 1, toolCalls: 0, usage: emptyUsage(), startedAtMs: at, metadata: {} };
      await inactive.commit(inactiveLease.admit({ sessionId: session.id, fence: 1, turn, events: [{ type: "turn/started", sessionId: session.id, emittedAtMs: at, turn }] }));
      const item: Item = { id: newId("item"), sessionId: session.id, turnId: turn.id, seq: 0, step: 1, type: "agentMessage", status: "failed", createdAtMs: at, completedAtMs: at, text: "legacy partial", phase: "finalAnswer" };
      await inactive.commit(inactiveLease.admit({ sessionId: session.id, fence: 1, items: [item], events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: at, item }] }));
      const legacy = { ...item, id: newId("item"), seq: 4 };
      const legacyEvent = { type: "item/completed", sessionId: session.id, emittedAtMs: at, seq: 4, item: legacy };
      await inactiveConn.query("START TRANSACTION");
      try {
        // Exactly the legacy SQL column list: the new private projection is omitted, not forged.
        await inactiveConn.query("INSERT INTO items (item_id,session_id,user_id,turn_id,seq,type,status,body,created_at_ms,completed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [legacy.id, session.id, session.userId, turn.id, 4, legacy.type, legacy.status, JSON.stringify(legacy), at, at]);
        await inactiveConn.query("INSERT INTO events (session_id,seq,user_id,type,body,emitted_at_ms) VALUES (?,?,?,?,?,?)",
          [session.id, 4, session.userId, legacyEvent.type, JSON.stringify(legacyEvent), at]);
        await inactiveConn.query("UPDATE sessions SET last_seq=4 WHERE session_id=?", [session.id]);
        await inactiveConn.query("COMMIT");
      } catch (error) { await inactiveConn.query("ROLLBACK"); throw error; }
      const [before] = await inactiveConn.query<RowDataPacket[]>("SELECT item_id,body,telemetry_failure_classification,telemetry_capture_v2_control_generation FROM items WHERE session_id=? ORDER BY item_id", [session.id]);
      expect(before.find((row) => row.item_id === item.id)).toMatchObject({ telemetry_failure_classification: "runtime_unknown", telemetry_capture_v2_control_generation: 0 });
      expect(before.find((row) => row.item_id === legacy.id)).toMatchObject({ telemetry_failure_classification: null, telemetry_capture_v2_control_generation: null });
      expect(await inactive.getTenantTelemetryPersistedProviderCaptureBinding()).toBeNull();
      await inactiveOwner!.activatePrimary();
      inactive=await inactiveOwner!.openStore(2);
      const cutoverLease=await acquireFixtureSessionAuthority(inactive,session,1);
      await activateCaptureFixture(inactive);
      expect(await inactive.getTenantTelemetryPersistedProviderCaptureActivationReceipt()).toMatchObject({ preCutoverFailureCount: 2 });
      expect(await inactive.getTenantTelemetryPersistedProviderCaptureCoverage(session.tenantId)).toMatchObject({ captureStatus: "capture_since_cutover", preCutoverHistoryStatus: "pre_cutover_history_unknown" });
      expect(await inactive.verifyPersistedProviderStepFailureSource({ tenantId: session.tenantId, sessionId: session.id, turnId: turn.id, itemId: item.id, stepIndex: 1 })).toMatchObject({ status: "not_found", sourceCount: 0 });
      await expect(inactive.commit(cutoverLease.admit({ sessionId: session.id, fence: cutoverLease.fence, items: [{ ...item, text: "post-cutover rewrite" }] }))).rejects.toThrow();
      await expect(inactive.commit(cutoverLease.admit({ sessionId: session.id, fence: cutoverLease.fence, items: [{ ...legacy, text: "post-cutover legacy rewrite" }] }))).rejects.toThrow();
      const [after] = await inactiveConn.query<RowDataPacket[]>("SELECT item_id,body,telemetry_failure_classification,telemetry_capture_v2_control_generation FROM items WHERE session_id=? ORDER BY item_id", [session.id]);
      expect(after).toEqual(before);
    });
  });
} else {
  describe("persisted provider-step capture: real MySQL transaction and isolation", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 for real disposable MySQL transaction proofs", () => {});
  });
}
