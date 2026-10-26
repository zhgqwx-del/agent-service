import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type Action = "start-services" | "stop-services" | "restart-services" | "start-infrastructure" | "stop-infrastructure" | "restart-infrastructure";
type Operation = { id: string; action: Action; state: "running" | "succeeded" | "failed" | "unknown"; phase: string;
  startedAt: string; finishedAt: string | null; error: string | null; message: string };
type Component = { id: string; state: string; pid?: number; endpoint?: string; [key: string]: unknown };
type Snapshot = { overall: string; components: Component[]; [key: string]: unknown };
type Status = { enabled: boolean; overall: string; components: Component[]; actions: { id: Action; enabled: boolean; reason: string }[]; operation: Operation | null };
type Driver = { snapshot(): Promise<Snapshot>; checkIdle(): Promise<unknown>;
  inspect?(): Promise<{ snapshot: Snapshot; idle: unknown }>;
  capabilities?(snapshot: Snapshot): Record<string, unknown> | Promise<Record<string, unknown>>;
  perform(action: Action, context: { phase(message: string): Promise<void>; operation: Operation }): Promise<void> };
type Controller = { status(): Promise<Status>; act(input: unknown): Promise<{ operation: Operation }>; close(): Promise<void> };
let module: { ENVIRONMENT_ACTIONS: readonly Action[]; createEnvironmentController(options: { driver: Driver; journalPath?: string | null }): Promise<Controller> };
beforeAll(async () => {
  module = await import(new URL("../scripts/ops/local-environment-controller.mjs", import.meta.url).href) as typeof module;
});
const KEY = "00000000-0000-4000-8000-000000000001";
const KEY2 = "00000000-0000-4000-8000-000000000002";
const SECRET = "fixture-private-provider-key-must-not-reach-environment-ui";
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function driver() {
  const state = { idle: true as unknown, snapshot: { overall: "ready", components: ["owner", "router", "runner", "mysql", "redis"].map(id => ({ id, state: "ready" })) } as Snapshot,
    calls: [] as { action: Action; operation: Operation }[], capabilities: undefined as Record<string, unknown> | undefined };
  const value: Driver = {
    async snapshot() { return state.snapshot; },
    async checkIdle() { return state.idle; },
    async perform(action, context) { state.calls.push({ action, operation: context.operation }); await context.phase("draining"); },
  };
  return { state, value };
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-environment-control-")));
  await chmod(directory, 0o700);
  return { directory, journalPath: join(directory, "environment-journal.json"), async close() { await rm(directory, { recursive: true, force: true }); } };
}
async function settled(controller: Controller) {
  const deadline = performance.now() + 2_500;
  while (performance.now() < deadline) {
    const status = await controller.status();
    if (status.operation?.state !== "running") return status;
    await new Promise<void>(done => setTimeout(done, 2));
  }
  throw new Error("fixture operation did not settle");
}
function action(action: Action = "restart-services", idempotencyKey = KEY) { return { action, idempotencyKey }; }
function savedOperation(state = "running") {
  return { id: KEY, action: "restart-services", state, phase: "draining", startedAt: "2026-10-26T12:00:00.000Z", finishedAt: null, error: null };
}

// These deterministic driver tests do not start a service, database or provider.
// Native identity and infrastructure continuity remain the bound driver's responsibility.
describe("local environment action admission and retained journal", () => {
  it("combines only one invocation's observations and still checks idle after durable acceptance", async () => {
    const d = driver(); let inspections = 0, snapshots = 0, checks = 0;
    d.value.inspect = async () => { inspections++; return { snapshot: d.state.snapshot, idle: d.state.idle }; };
    d.value.snapshot = async () => { snapshots++; return d.state.snapshot; };
    d.value.checkIdle = async () => { checks++; return false; };
    const controller = await module.createEnvironmentController({ driver: d.value });
    try {
      expect((await controller.status()).actions.some(item => item.enabled)).toBe(true);
      expect((await controller.status()).actions.some(item => item.enabled)).toBe(true);
      expect(inspections).toBe(2); expect(snapshots).toBe(0); expect(checks).toBe(0);
      await controller.act(action());
      expect((await settled(controller)).operation?.state).toBe("failed");
      expect(inspections).toBeGreaterThanOrEqual(3); expect(checks).toBe(1); expect(d.state.calls).toEqual([]);
      d.state.idle = false;
      expect((await controller.status()).overall).toBe("ready"); // Busy work alone is not an identity fault.
      await expect(controller.act(action("stop-services", KEY2))).rejects.toMatchObject({ code: "environment_action_blocked" });
    } finally { await controller.close(); }
  });

  it.each(["throw", "snapshot", "idle", "owner"])("fails closed when combined inspection has %s failure", async fault => {
    const d = driver(); let fallbackChecks = 0;
    d.value.checkIdle = async () => { fallbackChecks++; return true; };
    d.value.inspect = async () => {
      if (fault === "throw") throw new Error(SECRET);
      const snapshot = structuredClone(d.state.snapshot);
      if (fault === "snapshot") snapshot.overall = "invalid";
      if (fault === "owner") snapshot.components[0]!.state = "unknown";
      return { snapshot, idle: fault === "idle" ? "true" : true };
    };
    const controller = await module.createEnvironmentController({ driver: d.value });
    try {
      const status = await controller.status();
      expect(status.actions.every(item => !item.enabled)).toBe(true); expect(JSON.stringify(status)).not.toContain(SECRET);
      await expect(controller.act(action())).rejects.toMatchObject({ code: "environment_action_blocked" });
      expect(fallbackChecks).toBe(0); expect(d.state.calls).toEqual([]);
    } finally { await controller.close(); }
  });

  it.each(["status", "logs", "down", "migrate", "initialize", "reset", "rm -rf", "__proto__", "restart-services; env"])
    ("rejects non-enumerated action %s without invoking the driver", async command => {
      const d = driver(), controller = await module.createEnvironmentController({ driver: d.value });
      try {
        await expect(controller.act({ action: command, idempotencyKey: KEY })).rejects.toMatchObject({ code: "environment_action_invalid", status: 400 });
        expect(d.state.calls).toEqual([]);
      } finally { await controller.close(); }
    });

  it("rejects extra authority, inherited fields, getters and invalid operation identifiers", async () => {
    const d = driver(), controller = await module.createEnvironmentController({ driver: d.value });
    let getterCalls = 0;
    const getter = { idempotencyKey: KEY };
    Object.defineProperty(getter, "action", { enumerable: true, get() { getterCalls++; return "restart-services"; } });
    try {
      for (const input of [{ ...action(), command: "arbitrary" }, { ...action(), path: "/private/elsewhere" },
        { ...action(), env: { NODE_OPTIONS: SECRET } }, { ...action(), idempotencyKey: "unbounded-retry-key" },
        { ...action(), idempotencyKey: "00000000-0000-4000-0000-000000000001" }, Object.create(action()), getter, null, []]) {
        await expect(controller.act(input)).rejects.toMatchObject({ code: "environment_action_invalid", status: 400 });
      }
      expect(getterCalls).toBe(0); expect(d.state.calls).toEqual([]);
    } finally { await controller.close(); }
  });

  it("publishes a durable running operation before native work and records a safe phase", async () => {
    const f = await fixture(), d = driver(), entered = deferred(), release = deferred();
    const observed: unknown[] = [];
    d.value.perform = async (selected, context) => {
      d.state.calls.push({ action: selected, operation: context.operation });
      observed.push(JSON.parse(await readFile(f.journalPath, "utf8")));
      await context.phase("draining"); entered.resolve(); await release.promise;
    };
    const controller = await module.createEnvironmentController({ driver: d.value, journalPath: f.journalPath });
    try {
      const accepted = await controller.act(action()); await entered.promise;
      expect(accepted.operation).toMatchObject({ id: KEY, action: "restart-services", state: "running", phase: "accepted" });
      expect(observed).toMatchObject([{ currentId: KEY, operations: [{ id: KEY, state: "running" }] }]);
      const status = await controller.status(); expect(status.overall).toBe("transitioning");
      expect(status.operation?.phase).toBe("draining"); expect(status.actions.every(item => !item.enabled)).toBe(true);
      expect((await lstat(f.journalPath)).mode & 0o777).toBe(0o600);
      release.resolve(); await controller.close();
      expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toMatchObject({ operations: [{ state: "succeeded", phase: "completed" }] });
      expect(d.state.calls).toHaveLength(1);
    } finally { release.resolve(); await controller.close(); await f.close(); }
  });

  it("replays one operation for the same key during admission, running and after completion", async () => {
    const d = driver(), entered = deferred(), release = deferred(), snapshotGate = deferred();
    let firstSnapshot = true;
    d.value.snapshot = async () => { if (firstSnapshot) { firstSnapshot = false; await snapshotGate.promise; } return d.state.snapshot; };
    d.value.perform = async (selected, context) => { d.state.calls.push({ action: selected, operation: context.operation }); entered.resolve(); await release.promise; };
    const controller = await module.createEnvironmentController({ driver: d.value });
    try {
      const first = controller.act(action()), repeated = controller.act(action()); snapshotGate.resolve();
      expect(await repeated).toEqual(await first); await entered.promise;
      expect((await controller.act(action())).operation).toMatchObject({ id: KEY, state: "running" });
      await expect(controller.act(action("stop-services"))).rejects.toMatchObject({ code: "environment_idempotency_conflict", status: 409 });
      await expect(controller.act(action("restart-services", KEY2))).rejects.toMatchObject({ code: "environment_operation_conflict", status: 409 });
      release.resolve(); expect((await settled(controller)).operation?.state).toBe("succeeded");
      expect((await controller.act(action())).operation.state).toBe("succeeded"); expect(d.state.calls).toHaveLength(1);
    } finally { snapshotGate.resolve(); release.resolve(); await controller.close(); }
  });

  it("rejects another action while the first admission is still awaiting inspection", async () => {
    const d = driver(), entered = deferred(), release = deferred();
    d.value.snapshot = async () => { entered.resolve(); await release.promise; return d.state.snapshot; };
    const controller = await module.createEnvironmentController({ driver: d.value });
    let pending: Promise<{ operation: Operation }> | undefined;
    try {
      pending = controller.act(action()); await entered.promise;
      await expect(controller.act(action("stop-infrastructure", KEY2))).rejects.toMatchObject({ code: "environment_operation_conflict" });
      await expect(controller.act(action("stop-services"))).rejects.toMatchObject({ code: "environment_idempotency_conflict" });
      expect(d.state.calls).toHaveLength(0); release.resolve(); await pending;
    } finally { release.resolve(); await pending?.catch(() => {}); await controller.close(); }
  });

  it.each([false, undefined, 0, "true"])("does not admit destructive work for an unproven idle result %s", async idle => {
    const d = driver(); d.state.idle = idle;
    const controller = await module.createEnvironmentController({ driver: d.value });
    try {
      expect((await controller.status()).actions.every(item => !item.enabled)).toBe(true);
      await expect(controller.act(action("stop-infrastructure"))).rejects.toMatchObject({ code: "environment_action_blocked", status: 409 });
      expect(d.state.calls).toEqual([]);
    } finally { await controller.close(); }
  });

  it("checks idle again after acceptance and refuses native work if a turn has appeared", async () => {
    const d = driver(); let checks = 0;
    d.value.checkIdle = async () => ++checks === 1;
    const controller = await module.createEnvironmentController({ driver: d.value });
    try {
      await controller.act(action("stop-infrastructure"));
      expect((await settled(controller)).operation).toMatchObject({ state: "failed", phase: "accepted", error: "environment_operation_failed" });
      expect(d.state.calls).toEqual([]);
    } finally { await controller.close(); }
  });

  it.each(["overall", "owner", "mysql"])("fails closed for unknown %s identity", async fault => {
    const d = driver();
    if (fault === "overall") d.state.snapshot.overall = "unknown";
    else d.state.snapshot.components.find(item => item.id === fault)!.state = "unknown";
    const controller = await module.createEnvironmentController({ driver: d.value });
    try {
      expect((await controller.status()).actions.every(item => !item.enabled)).toBe(true);
      await expect(controller.act(action())).rejects.toMatchObject({ code: "environment_action_blocked" });
      expect(d.state.calls).toEqual([]);
    } finally { await controller.close(); }
  });

  it("honors the driver's action capabilities while retaining controller safety checks", async () => {
    const d = driver();
    d.value.capabilities = async () => ({ "restart-services": true, "stop-infrastructure": { enabled: false, reason: SECRET } });
    const controller = await module.createEnvironmentController({ driver: d.value });
    try {
      const status = await controller.status();
      expect(status.actions.find(item => item.id === "restart-services")?.enabled).toBe(true);
      expect(status.actions.filter(item => item.id !== "restart-services").every(item => !item.enabled)).toBe(true);
      expect(JSON.stringify(status)).not.toContain(SECRET);
      await expect(controller.act(action("stop-infrastructure"))).rejects.toMatchObject({ code: "environment_action_blocked" });
      expect(d.state.calls).toEqual([]);
    } finally { await controller.close(); }
  });

  it.each(["start-infrastructure", "start-services"] as const)
    ("can admit %s with stopped targets when the bound driver proves idle", async selected => {
      const d = driver(); d.state.snapshot.overall = selected === "start-infrastructure" ? "stopped" : "partial";
      for (const component of d.state.snapshot.components) {
        if (component.id === "owner") continue;
        if (selected === "start-infrastructure" || ["router", "runner"].includes(component.id)) component.state = "stopped";
      }
      d.value.capabilities = async () => ({ [selected]: true });
      const controller = await module.createEnvironmentController({ driver: d.value });
      try {
        expect((await controller.status()).actions.find(item => item.id === selected)?.enabled).toBe(true);
        await controller.act(action(selected));
        expect((await settled(controller)).operation?.state).toBe("succeeded");
        expect(d.state.calls.map(item => item.action)).toEqual([selected]);
      } finally { await controller.close(); }
    });

  it("retains the last phase and emits fixed errors without leaking native exceptions", async () => {
    const f = await fixture(), d = driver();
    d.value.perform = async (_action, context) => { await context.phase("waiting_for_runner_close"); throw new Error(SECRET); };
    const controller = await module.createEnvironmentController({ driver: d.value, journalPath: f.journalPath });
    try {
      await controller.act(action("stop-infrastructure"));
      const status = await settled(controller);
      expect(status.operation).toMatchObject({ state: "failed", phase: "waiting_for_runner_close", error: "environment_operation_failed" });
      expect(JSON.stringify(status)).not.toContain(SECRET); await controller.close();
      expect(await readFile(f.journalPath, "utf8")).not.toContain(SECRET);
    } finally { await controller.close(); await f.close(); }
  });

  it("does not publish driver diagnostics, credentials, executable arguments or arbitrary endpoints", async () => {
    const d = driver();
    d.state.snapshot = { overall: "ready", token: SECRET, components: d.state.snapshot.components.map(item => ({ ...item,
      name: SECRET, detail: SECRET, command: SECRET, env: SECRET, endpoint: `mysql://user:${SECRET}@127.0.0.1:3306/private` })) };
    const controller = await module.createEnvironmentController({ driver: d.value });
    try {
      const status = await controller.status();
      expect(JSON.stringify(status)).not.toContain(SECRET); expect(status.components.every(item => item.endpoint === undefined)).toBe(true);
      d.value.snapshot = async () => { throw new Error(SECRET); };
      const failed = await controller.status(); expect(failed.overall).toBe("unknown");
      expect(failed.actions.every(item => !item.enabled)).toBe(true); expect(JSON.stringify(failed)).not.toContain(SECRET);
    } finally { await controller.close(); }
  });

  it("rejects dynamic phase diagnostics and keeps them out of the journal and UI", async () => {
    const d = driver(); d.value.perform = async (_selected, context) => { await context.phase(`native error: ${SECRET}`); };
    const controller = await module.createEnvironmentController({ driver: d.value });
    try {
      await controller.act(action()); const status = await settled(controller);
      expect(status.operation).toMatchObject({ state: "failed", phase: "accepted", error: "environment_operation_failed" });
      expect(JSON.stringify(status)).not.toContain(SECRET);
    } finally { await controller.close(); }
  });

  it("reloads an interrupted operation as unknown without replaying native actions", async () => {
    const f = await fixture(), d = driver();
    await writeFile(f.journalPath, JSON.stringify({ schema: "local-environment-journal-v1", currentId: KEY, operations: [savedOperation()] }), { mode: 0o600 });
    const controller = await module.createEnvironmentController({ driver: d.value, journalPath: f.journalPath });
    try {
      const status = await controller.status();
      expect(status.overall).toBe("unknown"); expect(status.operation).toMatchObject({ id: KEY, state: "unknown", phase: "draining", error: "environment_operation_unknown" });
      expect(status.actions.every(item => !item.enabled)).toBe(true);
      expect((await controller.act(action())).operation.state).toBe("unknown");
      await expect(controller.act(action("restart-services", KEY2))).rejects.toMatchObject({ code: "environment_operation_conflict" });
      expect(d.state.calls).toEqual([]); expect(await readFile(f.journalPath, "utf8")).toContain('"state":"unknown"');
    } finally { await controller.close(); await f.close(); }
  });

  it("remembers completed idempotency keys across controller restart and preserves existing data bytes", async () => {
    const f = await fixture(), d = driver(), retained = join(f.directory, "existing-service-data");
    await writeFile(retained, Buffer.from([0, 255, 1, 42]), { mode: 0o600 });
    let controller = await module.createEnvironmentController({ driver: d.value, journalPath: f.journalPath });
    try {
      await controller.act(action()); await controller.close();
      controller = await module.createEnvironmentController({ driver: d.value, journalPath: f.journalPath });
      expect((await controller.act(action())).operation.state).toBe("succeeded"); expect(d.state.calls).toHaveLength(1);
      await controller.act(action("restart-infrastructure", KEY2)); await controller.close();
      expect(d.state.calls.map(item => item.action)).toEqual(["restart-services", "restart-infrastructure"]);
      expect(await readFile(retained)).toEqual(Buffer.from([0, 255, 1, 42]));
    } finally { await controller.close(); await f.close(); }
  });

  it.each(["public_file", "public_parent", "symlink", "invalid_json", "duplicate_operation", "other_unresolved_operation"])
    ("rejects unsafe journal %s without native work or deleting retained data", async fault => {
      const f = await fixture(), d = driver();
      const completed = { ...savedOperation("succeeded"), phase: "completed", finishedAt: "2026-10-26T12:00:01.000Z" };
      let saved: unknown = { schema: "local-environment-journal-v1", currentId: KEY, operations: [completed] };
      if (fault === "duplicate_operation") saved = { schema: "local-environment-journal-v1", currentId: KEY, operations: [completed, completed] };
      if (fault === "other_unresolved_operation") saved = { schema: "local-environment-journal-v1", currentId: KEY2, operations: [savedOperation(), { ...completed, id: KEY2 }] };
      await writeFile(f.journalPath, fault === "invalid_json" ? "{broken" : JSON.stringify(saved), { mode: 0o600 });
      try {
        if (fault === "public_file") await chmod(f.journalPath, 0o644);
        if (fault === "public_parent") await chmod(f.directory, 0o755);
        if (fault === "symlink") {
          const target = join(f.directory, "original-journal.json"); await writeFile(target, JSON.stringify(saved), { mode: 0o600 });
          await rm(f.journalPath); await symlink(target, f.journalPath);
        }
        await expect(module.createEnvironmentController({ driver: d.value, journalPath: f.journalPath })).rejects.toMatchObject({ code: "environment_journal_invalid", status: 503 });
        expect(d.state.calls).toEqual([]); expect(await lstat(f.journalPath)).toBeDefined();
      } finally { await f.close(); }
    });

  it("refuses to perform if durable acceptance cannot be recorded", async () => {
    const f = await fixture(), d = driver();
    const controller = await module.createEnvironmentController({ driver: d.value, journalPath: f.journalPath });
    try {
      await chmod(f.directory, 0o755);
      await expect(controller.act(action())).rejects.toMatchObject({ code: "environment_journal_unavailable", status: 503 });
      const status = await controller.status(); expect(status.overall).toBe("unknown");
      expect(status.operation?.state).toBe("unknown"); expect(status.actions.every(item => !item.enabled)).toBe(true);
      expect(d.state.calls).toEqual([]);
    } finally { await chmod(f.directory, 0o700); await controller.close(); await f.close(); }
  });

  it("joins accepted work on close and seals admission without issuing a shutdown itself", async () => {
    const d = driver(), entered = deferred(), release = deferred();
    d.value.perform = async (selected, context) => { d.state.calls.push({ action: selected, operation: context.operation }); entered.resolve(); await release.promise; };
    const controller = await module.createEnvironmentController({ driver: d.value });
    let closed = false;
    try {
      await controller.act(action()); await entered.promise;
      const closing = controller.close().then(() => { closed = true; }); await new Promise<void>(done => setImmediate(done));
      expect(closed).toBe(false);
      await expect(controller.act(action("stop-infrastructure", KEY2))).rejects.toMatchObject({ code: "environment_operation_conflict" });
      release.resolve(); await closing; expect(closed).toBe(true); expect(d.state.calls).toHaveLength(1);
      expect((await controller.status()).actions.every(item => !item.enabled)).toBe(true);
    } finally { release.resolve(); await controller.close(); }
  });
});
