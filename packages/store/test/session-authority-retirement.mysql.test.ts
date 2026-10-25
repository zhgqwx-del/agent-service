import { beforeAll, describe, expect, it } from "vitest";
import { SessionAuthorityActivationAdmissionError } from "../src/mysql/session-authority-operator-admission.js";
import { captureSessionAuthorityBindingCommand } from "../src/index.js";
import { prepareRetirementOldMigrations, retirementCase } from "./fixtures/authority-retirement.js";

// Dedicated native profile. It does not depend on a Darwin VM or count an absent profile as proof.
const suite = process.env.AGENT_SERVICE_INTEGRATION ? describe : describe.skip;
suite("native MySQL versioned-account retirement and ordinary authority isolation", () => {
  let oldDirectory = "";
  beforeAll(async () => { oldDirectory = await prepareRetirementOldMigrations(); });

  it("refuses an idle old authenticated connection after every old host is locked and USAGE-only, then activates only the same command after native close", async context => {
    await retirementCase(context, oldDirectory, async f => {
      const session = await f.seed(), old = await f.connectRaw(f.oldUrl);
      const identity = await old.rows("SELECT CURRENT_USER() AS account,CONNECTION_ID() AS id");
      expect(identity).toEqual([expect.objectContaining({ account: `${f.oldName}@${f.host}` })]);
      await f.upgrade(); await f.retireOld();
      const native = await f.oldNativeState(); expect(native.threads).toEqual([expect.objectContaining({ id: identity[0]!.id, user: f.oldName })]);
      expect(native.transactions).toEqual([]);
      const operator = await f.operator(), command = f.command!;
      const fixedSha = captureSessionAuthorityBindingCommand(command.command).commandSha256;
      const before = await f.snapshot();
      // ACKs are intentionally insufficient here. The real native admission must see the old socket.
      const error: unknown = await operator.preflightSessionAuthorityBinding().then(() => null, reason => reason);
      expect(error).toBeInstanceOf(SessionAuthorityActivationAdmissionError);
      expect(error).toMatchObject({ code: "session_authority_activation_admission_failed", reason: "retired_connection" });
      expect(await f.snapshot()).toEqual(before);
      await old.close(); await f.awaitOldClosed();
      const denied: unknown = await f.connectRaw(f.oldUrl).then(() => null, reason => reason);
      const actual = denied as { errno?: unknown; code?: unknown; sqlState?: unknown };
      expect([{ errno: 1045, code: "ER_ACCESS_DENIED_ERROR", sqlState: "28000" },
        { errno: 3118, code: "ER_ACCOUNT_HAS_BEEN_LOCKED", sqlState: "HY000" }])
        .toContainEqual({ errno: actual.errno, code: actual.code, sqlState: actual.sqlState });
      await f.activate(operator);
      expect(f.command).toBe(command); expect(captureSessionAuthorityBindingCommand(f.command!.command).commandSha256).toBe(fixedSha);
      await f.proveOrdinaryWrite(session);
    });
  });

  it("refuses a real uncommitted old-account transaction and preserves its cold bytes after actual rollback and native retirement", async context => {
    await retirementCase(context, oldDirectory, async f => {
      const session = await f.seed(), old = await f.connectRaw(f.oldUrl);
      await f.upgrade(); // Old connection survives idle; no pre-DDL transaction is held across ALTER.
      const before = await f.snapshot();
      const identity = await old.rows("SELECT CONNECTION_ID() AS id,CURRENT_USER() AS account");
      expect(identity[0]?.account).toBe(`${f.oldName}@${f.host}`);
      await old.begin();
      await old.exec(`UPDATE \`${f.database}\`.sessions SET title=? WHERE BINARY session_id=BINARY ?`, ["must-never-commit", session.id]);
      expect(await old.rows(`SELECT title FROM \`${f.database}\`.sessions WHERE BINARY session_id=BINARY ?`, [session.id])).toEqual([expect.objectContaining({ title: "must-never-commit" })]);
      // INNODB_TRX is observed through actual engine evidence, never an elapsed-timer guess.
      const native = await f.awaitOldTransaction(identity[0]!.id as number); expect(native.threads).toEqual([expect.objectContaining({ id: identity[0]!.id })]);
      expect(native.transactions).toEqual([expect.objectContaining({ trx_mysql_thread_id: identity[0]!.id })]);
      await f.retireOld();
      const operator = await f.operator(), fixed = f.command;
      const failure: unknown = await operator.preflightSessionAuthorityBinding().then(() => null, reason => reason);
      expect(failure).toBeInstanceOf(SessionAuthorityActivationAdmissionError);
      expect(failure).toMatchObject({ reason: "retired_connection" }); expect(await f.snapshot()).toEqual(before);
      await old.rollback(); await old.close(); await f.awaitOldClosed();
      const cold = await f.connectRaw(f.operatorUrl);
      expect((await cold.rows("SELECT CONNECTION_ID() AS id"))[0]?.id).not.toBe(identity[0]!.id);
      expect(await cold.rows("SELECT title FROM sessions WHERE BINARY session_id=BINARY ?", [session.id])).toEqual([expect.objectContaining({ title: "old-stable" })]);
      await cold.close(); expect(await f.snapshot()).toEqual(before);
      await f.activate(operator); expect(f.command).toBe(fixed); await f.proveOrdinaryWrite(session);
    });
  });

  it("denies all twelve native control-table IUD statements while the same bound restricted account can commit ordinary item usage and billing", async context => {
    type Phase = "test_enter" | "fixture_prepare_enter" | "fixture_prepare_done"
      | "seed" | "upgrade" | "retire_old" | "await_old_closed" | "activate"
      | "runtime_open" | "runtime_identity" | "snapshot_before" | "control_read"
      | "control_denial" | "snapshot_after_denial" | "twelve_denials_assert"
      | "runtime_close" | "ordinary_write" | "body_done" | "fixture_cleanup_enter"
      | "cleanup_startup_wait" | "cleanup_runner_join" | "cleanup_store_join" | "cleanup_raw_join"
      | "cleanup_native_preflight" | "cleanup_drop_databases" | "cleanup_admin_join"
      | "cleanup_failed" | "cleanup_done" | "fixture_cleanup_settled";
    type ObservedBy = "abort" | "body-error" | "fixture-error" | "test-failed";
    let phase: Phase = "test_enter", began: number | undefined;
    try { began = performance.now(); } catch { /* Observation is optional. */ }
    const markPhase = (next: Phase) => { phase = next; };
    const snapshot = (observedBy: ObservedBy) => began === undefined ? undefined : ({ phase,
      elapsedMs: Math.max(0, Math.floor(performance.now() - began)), observedBy, signalAborted: context.signal.aborted });
    let firstDiagnostic: ReturnType<typeof snapshot>;
    const freeze = (observedBy: ObservedBy) => {
      try { firstDiagnostic ??= snapshot(observedBy); } catch { /* Never replace the original failure. */ }
    };
    const observeAbort = () => freeze("abort");
    // Observe before retirementCase can attach any owner's real cancellation listener.
    try {
      context.signal.addEventListener("abort", observeAbort, { once: true });
      if (context.signal.aborted) observeAbort();
    } catch { /* Observation cannot affect owner cancellation. */ }
    try {
      context.onTestFailed(() => {
        try {
          const observed = firstDiagnostic ?? snapshot("test-failed");
          if (observed) console.error(JSON.stringify({ schema: "mysql-case-phase-diagnostic-v1",
            caseLabel: "session_authority_retirement_twelve_control_iud", ...observed }));
        } catch { /* Never replace the original test or cleanup failure. */ }
      });
    } catch { /* Diagnostic registration cannot affect the original case. */ }
    const observeFixture = (event: { stage: string }) => {
      switch (event.stage) {
        case "fixture_prepare_enter": case "fixture_prepare_done": case "fixture_cleanup_enter":
        case "cleanup_startup_wait": case "cleanup_runner_join": case "cleanup_store_join": case "cleanup_raw_join":
        case "cleanup_native_preflight": case "cleanup_drop_databases": case "cleanup_admin_join":
        case "cleanup_failed": case "cleanup_done": case "fixture_cleanup_settled":
          markPhase(event.stage);
      }
    };
    try {
    await retirementCase(context, oldDirectory, async f => {
      try {
      markPhase("seed");
      const session = await f.seed(); markPhase("upgrade"); await f.upgrade(); markPhase("retire_old"); await f.retireOld(); markPhase("await_old_closed"); await f.awaitOldClosed(); markPhase("activate"); await f.activate();
      markPhase("runtime_open");
      const runtime = await f.connectRaw(f.newUrl);
      markPhase("runtime_identity");
      expect(await runtime.rows("SELECT CURRENT_USER() AS account,DATABASE() AS db,@@GLOBAL.server_uuid AS uuid"))
        .toEqual([expect.objectContaining({ account: `${f.newName}@${f.host}`, db: f.database, uuid: f.uuid })]);
      const controls = ["schema_migrations", "session_authority_control", "session_authority_bindings", "session_authority_runtime_accounts"] as const;
      const tables = [...controls, "sessions", "events", "items", "turns", "approvals", "usage_ledger", "billing_usage_facts", "lifecycle_outbox", "idempotency_keys"];
      markPhase("snapshot_before");
      const before = await f.snapshot(false, tables); let checked = 0;
      for (const name of controls) {
        markPhase("control_read");
        expect(await runtime.rows(`SELECT COUNT(*) AS n FROM \`${name}\``)).toHaveLength(1);
        const key = name === "schema_migrations" ? "name" : name === "session_authority_control" ? "control_id" : "binding_id";
        for (const sql of [`INSERT INTO \`${name}\` SELECT * FROM \`${name}\` WHERE 1=0`,
          `UPDATE \`${name}\` SET \`${key}\`=\`${key}\` WHERE 1=0`, `DELETE FROM \`${name}\` WHERE 1=0`]) {
          markPhase("control_denial");
          await expect(runtime.exec(sql)).rejects.toMatchObject({ errno: 1142, code: "ER_TABLEACCESS_DENIED_ERROR", sqlState: "42000" });
          checked++; markPhase("snapshot_after_denial"); expect(await f.snapshot(false, tables)).toEqual(before);
        }
      }
      markPhase("twelve_denials_assert");
      expect(checked).toBe(12); markPhase("runtime_close"); await runtime.close(); markPhase("ordinary_write"); await f.proveOrdinaryWrite(session);
      markPhase("body_done");
      } catch (error) { freeze("body-error"); throw error; }
    }, undefined, observeFixture);
    } catch (error) { freeze("fixture-error"); throw error; }
    finally {
      try { context.signal.removeEventListener("abort", observeAbort); } catch { /* Observation only. */ }
    }
  }, 45_000);
});
