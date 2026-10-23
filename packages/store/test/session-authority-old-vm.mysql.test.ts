import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Session } from "@agent-service/protocol";
import { SessionAuthorityError } from "../src/index.js";
import { retirementCase, verifyRetirementOldVm, type RetirementDiagnostic } from "./fixtures/authority-retirement.js";

// Explicit local trusted-artifact profile. Not registered as cross-platform required coverage.
// If selected on an unsupported platform, verification fails; it never substitutes another VM.
const suite = process.env.AGENT_SERVICE_OLD_VM_NATIVE === "1" ? describe : describe.skip;
suite("trusted local pre-0066 VM and independent current authority migration", () => {
  let vm = "";
  beforeAll(async () => {
    const start = performance.now();
    try { console.info(JSON.stringify({ schema: "authority-old-vm-stage-v1", stage: "hook_payload_verify_enter", elapsedMs: 0 })); } catch { /* Observation only. */ }
    vm = await verifyRetirementOldVm();
    try { console.info(JSON.stringify({ schema: "authority-old-vm-stage-v1", stage: "hook_payload_verify_done", elapsedMs: Math.round(performance.now() - start) })); } catch { /* Observation only. */ }
  });
  it("preserves actual nonempty old-VM 0065 writes and rejects that same binary cold-starting 0066 with valid new credentials", async context => {
    const start = performance.now(); let records = 0, caseStage = "fixture_prepare", lastState: unknown;
    const observe: RetirementDiagnostic = event => {
      if (event.state !== undefined) lastState = event.state;
      if (++records > 96) return;
      try { console.info(JSON.stringify({ schema: "authority-old-vm-stage-v1", index: records, limit: 96,
        elapsedMs: Math.round(performance.now() - start), caseStage, aborted: context.signal.aborted, ...event })); } catch { /* Observation only. */ }
    };
    const aborted = () => observe({ stage: "case_abort", state: lastState });
    context.signal.addEventListener("abort", aborted, { once: true });
    try {
      await retirementCase(context, join(vm, "dist/migrations"), async f => {
        const mark = (stage: string) => { caseStage = stage; observe({ stage, state: f.diagnosticState() }); };
        mark("old_start_enter"); const old = await f.startOldVm(vm); mark("old_start_done"); await old.ready(); mark("old_ready_done");
        const createdAgent = await old.request("/v1/agents", { name: "old-vm-no-provider-call", model: { provider: "fixture-no-call", model: "synthetic" }, tools: [] });
        expect(createdAgent.status).toBe(201); const agent = JSON.parse(createdAgent.body) as { id: string; version: number };
        const created = await old.request("/v1/sessions", { agentId: agent.id, agentVersion: agent.version,
          title: "old-stable", metadata: { witness: "actual-old-vm-http" } });
        expect(created.status).toBe(201); const session = Session.parse(JSON.parse(created.body));
        expect(session.tenantId).toBe("old-vm-fixture-tenant"); expect(session.userId).toBe("old-vm-user");
        mark("old_http_nonempty_done"); mark("old_snapshot_enter"); const before = await f.snapshot(true); mark("old_snapshot_done");
        const triggerSql = "SELECT TRIGGER_NAME,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_ORDER,ACTION_STATEMENT,ACTION_ORIENTATION,ACTION_TIMING,SQL_MODE,DEFINER,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION FROM information_schema.TRIGGERS WHERE BINARY TRIGGER_SCHEMA=BINARY ? ORDER BY BINARY TRIGGER_NAME";
        mark("old_guards_enter"); const oldGuards = await f.inspect(triggerSql, [f.database]); expect(oldGuards).toHaveLength(853); mark("old_guards_done");
        mark("old_native_close_enter"); await old.close(); await f.awaitOldClosed(); mark("old_native_close_done");
        mark("upgrade_enter"); await f.upgrade(); mark("upgrade_done"); expect(await f.snapshot(true)).toEqual(before); mark("upgrade_snapshot_done");
        const guards = await f.inspect(triggerSql, [f.database]); expect(guards).toHaveLength(865);
        const oldNames = new Set(oldGuards.map(row => String(row.TRIGGER_NAME)));
        expect(guards.filter(row => oldNames.has(String(row.TRIGGER_NAME)) && row.TRIGGER_NAME !== "trg_subagent_sessions_bu"))
          .toEqual(oldGuards.filter(row => row.TRIGGER_NAME !== "trg_subagent_sessions_bu"));
        expect(await f.inspect(`SELECT control_id,current_binding_id,binding_sequence FROM \`${f.database}\`.session_authority_control`))
          .toEqual([expect.objectContaining({ control_id: 1, current_binding_id: null, binding_sequence: 0 })]);
        expect(await f.inspect(`SELECT COUNT(*) AS n FROM \`${f.database}\`.sessions WHERE authority_binding_id IS NOT NULL OR authority_runner_id IS NOT NULL OR authority_runner_addr IS NOT NULL OR authority_boot_id IS NOT NULL OR authority_acquisition_sha256 IS NOT NULL OR authority_source_sha256 IS NOT NULL OR authority_expires_at_db_ms IS NOT NULL`))
          .toEqual([expect.objectContaining({ n: 0 })]);
        mark("inactive_snapshot_enter"); const inactiveBefore = await f.snapshot(); mark("inactive_snapshot_done");
        mark("inactive_cold_enter"); const inactive: unknown = await f.newStore().then(store => store.close().then(() => null), reason => reason);
        expect(inactive).toBeInstanceOf(SessionAuthorityError); expect(await f.snapshot()).toEqual(inactiveBefore); mark("inactive_cold_done");
        mark("retirement_enter"); await f.retireOld(); await f.awaitOldClosed(); mark("retirement_done");
        mark("activation_enter"); await f.activate(); mark("activation_done");
        // Actual new restricted credentials work in the new verified Store, before supplying them
        // to the old VM. No public API token or fingerprint failure is guessed from an auth error.
        mark("new_write_enter"); await f.proveOrdinaryWrite(session); mark("new_write_done");
        mark("new_write_snapshot_enter"); const after = await f.snapshot(); mark("new_write_snapshot_done");
        mark("cold_old_start_enter"); const coldOld = await f.startOldVm(vm, true); mark("cold_old_start_done");
        mark("cold_old_refusal_enter"); await coldOld.expectColdRefusal(); mark("cold_old_refusal_done"); await coldOld.close(); mark("cold_old_close_done");
        mark("cold_snapshot_enter"); expect(await f.snapshot()).toEqual(after); mark("cold_snapshot_done");
        // Complete immutable payload identity, including original bundled migrations, still holds.
        mark("final_payload_verify_enter"); expect(await verifyRetirementOldVm()).toBe(vm); mark("final_payload_verify_done");
        mark("case_body_done");
      }, vm, observe);
    } finally { context.signal.removeEventListener("abort", aborted); }
  }, 45_000);
});
