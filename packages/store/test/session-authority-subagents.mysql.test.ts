import { randomUUID } from "node:crypto";
import { describe, expect, it, type TestContext } from "vitest";
import type { RowDataPacket } from "mysql2/promise";
import { SessionAuthorityConflictError, attachSessionWriteAdmission } from "../src/index.js";
import type { MysqlSessionStore } from "../src/mysql/store.js";
import { CurrentMysqlRuntimeOwner, type CurrentMysqlInspection } from "./fixtures/current-mysql-runtime.js";
import { subagentFixture, subagentProviderInput, subagentTaskRequest, subagentLimits } from "./fixtures/subagents.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";

const suite = process.env.AGENT_SERVICE_INTEGRATION ? describe : describe.skip;
const TABLES = [
  ["sessions", "session_id"], ["events", "session_id,seq"], ["items", "item_id"], ["turns", "turn_id"],
  ["approvals", "approval_id"], ["usage_ledger", "id"], ["billing_usage_facts", "usage_id"],
  ["lifecycle_outbox", "outbox_id"], ["idempotency_keys", "tenant_id,user_id,session_id,idem_key"],
  ["subagent_root_turns", "root_key"], ["subagent_tasks", "task_id"], ["subagent_budget_entries", "entry_id"],
  ["session_authority_control", "control_id"], ["session_authority_bindings", "binding_id"],
  ["session_authority_runtime_accounts", "binding_id,account_user,account_host"],
] as const;
type Snapshot = Record<string, RowDataPacket[]>;
async function snapshot(observer: CurrentMysqlInspection): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const [table, order] of TABLES) { const [rows] = await observer.query<RowDataPacket[]>({ sql: `SELECT * FROM ${table} ORDER BY ${order}`, timeout: 5_000 }); result[table] = rows; }
  return result;
}
function exceptRootExpiry(value: Snapshot, sessionId: string): Snapshot {
  return { ...value, sessions: value.sessions!.map(row => row.session_id !== sessionId ? row : Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== "authority_expires_at_db_ms")) as RowDataPacket) };
}
function expiry(value: Snapshot, sessionId: string): number {
  const row = value.sessions!.find(row => row.session_id === sessionId), n = Number(row?.authority_expires_at_db_ms);
  if (!Number.isSafeInteger(n) || n < 0) throw Error("Managed expiry fixture tuple missing"); return n;
}
function noWriter(value: Snapshot) {
  for (const row of value.subagent_root_turns!) expect([row.writer_connection_id, row.writer_session_id, row.writer_mode, row.writer_fence]).toEqual([null, null, null, null]);
}
async function owned(context: TestContext, work: (first: MysqlSessionStore, second: MysqlSessionStore, observer: CurrentMysqlInspection) => Promise<void>) {
  const raw = process.env.MYSQL_TEST_URL;
  if (!raw) throw Error("Managed authority native suite requires explicit MYSQL_TEST_URL");
  const owner = new CurrentMysqlRuntimeOwner(raw); let abortClose: Promise<void> | undefined, passed = false, failed = false, firstError: unknown;
  const abort = () => { abortClose ??= owner.close({ successful: false }); void abortClose.catch(() => {}); };
  context.signal.addEventListener("abort", abort, { once: true }); if (context.signal.aborted) abort();
  try {
    await owner.prepare(); context.signal.throwIfAborted();
    const first = await owner.openStore(2, context.signal), second = await owner.openStore(2, context.signal), observer = await owner.openInspection(context.signal, 5_000);
    context.signal.throwIfAborted(); await work(first, second, observer); context.signal.throwIfAborted(); passed = true;
  } catch (error) { failed = true; firstError = error; }
  finally {
    try { await owner.close({ successful: passed && !failed && !context.signal.aborted }); await abortClose; }
    catch (error) { if (!failed) { failed = true; firstError = error; } }
    context.signal.removeEventListener("abort", abort);
  }
  if (failed) throw firstError;
}

suite("real MySQL exact authority expiry under the published subagent writer guard", () => {
  it("renews and releases active and closing managed roots without business changes, then rejects the prior proof after real takeover", async context => {
    await owned(context, async (first, second, observer) => {
      for (const closing of [false, true]) {
        const f = await subagentFixture(first, { maxSteps: closing ? 1 : 8 });
        const request = await subagentTaskRequest(f); await first.createSubagentTask(request.input);
        if (closing) {
          expect((await first.admitSubagentBudget(subagentProviderInput(f, f.access, 1))).admitted).toBe(true);
          const denied = await first.admitSubagentBudget(subagentProviderInput(f, f.access, 2));
          expect(denied).toMatchObject({ admitted: false, reason: "max_steps", root: { state: "closing" } });
        }
        expect((await first.getSubagentRoot({ access: f.access }))?.state).toBe(closing ? "closing" : "active");
        const before = await snapshot(observer); noWriter(before);
        await expect(observer.query({ sql: "UPDATE sessions SET authority_expires_at_db_ms=authority_expires_at_db_ms+1 WHERE session_id=?", timeout: 5_000 }, [f.session.id]))
          .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", errno: 1644, sqlState: "45000", sqlMessage: "Subagent root writer admission is required" });
        expect(await snapshot(observer)).toEqual(before);
        expect(await first.sessionAuthority.renew(f.proof, subagentLimits.maxWallClockMs)).toBe(true);
        const renewed = await snapshot(observer); noWriter(renewed);
        expect(expiry(renewed, f.session.id)).toBeGreaterThan(expiry(before, f.session.id));
        expect(exceptRootExpiry(renewed, f.session.id)).toEqual(exceptRootExpiry(before, f.session.id));
        await second.sessionAuthority.release(f.proof);
        const released = await snapshot(observer); noWriter(released); expect(expiry(released, f.session.id)).toBe(0);
        expect(exceptRootExpiry(released, f.session.id)).toEqual(exceptRootExpiry(before, f.session.id));
        expect(await first.sessionAuthority.renew(f.proof, subagentLimits.maxWallClockMs)).toBe(false);
        await first.sessionAuthority.release(f.proof); expect(await snapshot(observer)).toEqual(released);
        // A real confirmed P2 claim is the new baseline; takeover's family-unknown mutation is not
        // falsely included in a failed old-proof business commit's zero-mutation assertion.
        const p2 = await acquireFixtureSessionAuthority(second, f.session, 1);
        let p2Failed = false, p2First: unknown;
        try {
          const claimed = await snapshot(observer); noWriter(claimed);
          expect(await first.sessionAuthority.renew(f.proof, subagentLimits.maxWallClockMs)).toBe(false);
          await first.sessionAuthority.release(f.proof);
          await expect(first.commit(attachSessionWriteAdmission({ sessionId: f.session.id, fence: 1, sessionPatch: { title: "must-not-write" } }, f.proof)))
            .rejects.toBeInstanceOf(SessionAuthorityConflictError);
          expect(await snapshot(observer)).toEqual(claimed);
        } catch (error) { p2Failed = true; p2First = error; }
        finally { try { await p2.release(); } catch (error) { if (!p2Failed) { p2Failed = true; p2First = error; } } }
        if (p2Failed) throw p2First;
      }
    });
  });

  it("rolls back actual late expiry SQL rejection and all four writer fields before the same proof renews and releases successfully", async context => {
    await owned(context, async (first, second, observer) => {
      const f = await subagentFixture(first), request = await subagentTaskRequest(f); await first.createSubagentTask(request.input);
      const before = await snapshot(observer); noWriter(before);
      const trigger = `trg_managed_expiry_fault_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      let installed = false, failed = false, firstError: unknown;
      try {
        await observer.query({ sql: `CREATE TRIGGER \`${trigger}\` BEFORE UPDATE ON sessions FOR EACH ROW BEGIN IF BINARY NEW.session_id=BINARY '${f.session.id}' AND NOT(NEW.authority_expires_at_db_ms <=> OLD.authority_expires_at_db_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled managed expiry rejection'; END IF; END`, timeout: 5_000 }); installed = true;
        for (const operation of [() => first.sessionAuthority.renew(f.proof, subagentLimits.maxWallClockMs), () => second.sessionAuthority.release(f.proof)]) {
          await expect(operation()).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", errno: 1644, sqlState: "45000", sqlMessage: "controlled managed expiry rejection" });
          const after = await snapshot(observer); noWriter(after); expect(after).toEqual(before);
        }
      } catch (error) { failed = true; firstError = error; }
      finally {
        try { if (installed) await observer.query({ sql: `DROP TRIGGER \`${trigger}\``, timeout: 5_000 }); }
        catch (error) { if (!failed) { failed = true; firstError = error; } }
      }
      if (failed) throw firstError;
      expect(await first.sessionAuthority.renew(f.proof, subagentLimits.maxWallClockMs)).toBe(true);
      const renewed = await snapshot(observer); noWriter(renewed);
      expect(exceptRootExpiry(renewed, f.session.id)).toEqual(exceptRootExpiry(before, f.session.id));
      await second.sessionAuthority.release(f.proof);
      const released = await snapshot(observer); noWriter(released); expect(expiry(released, f.session.id)).toBe(0);
      expect(exceptRootExpiry(released, f.session.id)).toEqual(exceptRootExpiry(before, f.session.id));
    });
  });
});
