import type { ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Pin = { path: string; dev: number; ino: number; size: number; sha256: string };
type Witness = { pid: number; pgid: number; uid: number; started: string; executable: Pin };
type Close = { code: number | null; signal: NodeJS.Signals | null };
type Entry = { witness: Witness; child: ChildProcess; closed: Promise<Close> };
type Component = { id: string; state: string; pid?: number };
type Snapshot = { overall: string; components: Component[]; busy?: string | null };
type HookEntry = { witness: Witness; child?: ChildProcess; closed?: Promise<Close>; state: string; port: number; runId?: string; [key: string]: unknown };
type HookEntries = Record<string, HookEntry>;
type Driver = { snapshot(): Promise<Snapshot>; checkIdle(): Promise<boolean>; perform(action: string, context?: unknown): Promise<Snapshot>;
  capabilities(snapshot: Snapshot): Record<string, { enabled: boolean; reason: string }>;
  setHooks(hooks: { beforeAction(action: string, entries: HookEntries): Promise<void>; checkIdle(entries: HookEntries): Promise<boolean>;
    ready(name: string, entry: HookEntry): Promise<void>; beforeInfrastructureStop(name: string, entry: HookEntry): Promise<void>;
    afterInfrastructureStart(entries: HookEntries): Promise<{ redis: { runId: string } }> }): void };
let driverModule: { createLocalEnvironmentDriver(options: { profilePath: string }): Promise<Driver> };
let native: { pinFile(path: string): Promise<Pin>; assertListener(port: number, pid: number): Promise<void>;
  spawnOwned(spec: { executable: Pin; args: string[]; cwd: string; env: Record<string, string>; logPath: string }): Promise<Entry>;
  stopOwned(entry: Entry): Promise<unknown>; writePrivateJson(path: string, value: unknown, options?: { createOnly?: boolean }): Promise<unknown> };
beforeAll(async () => {
  driverModule = await import(new URL("../scripts/ops/local-environment-driver.mjs", import.meta.url).href) as typeof driverModule;
  native = await import(new URL("../scripts/ops/local-environment-native.mjs", import.meta.url).href) as typeof native;
});
const INITIAL_RUN = "a".repeat(40), NEXT_RUN = "b".repeat(40);
const SOURCE = `import { createServer } from "node:net";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [name, selectedPort, ready, trace, data, release] = process.argv.slice(2);
readFileSync(data);
const server = createServer(socket => socket.end());
let closing = false;
const close = () => {
  if (closing) return; closing = true;
  appendFileSync(trace, name + ":stop\\n");
  server.close(() => process.exit(0));
};
process.on("SIGTERM", close);
server.listen(Number(selectedPort), "127.0.0.1", () => {
  writeFileSync(ready, JSON.stringify({ pid: process.pid, port: server.address().port }), { mode: 0o600 });
  appendFileSync(trace, name + ":start\\n");
});
setInterval(() => { if (existsSync(release)) close(); }, 20);
`;
const NAMES = ["router", "runner", "mysql", "redis"];
async function until(predicate: () => Promise<boolean>, label: string, milliseconds = 10_000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>(done => setTimeout(done, 20));
  }
  throw new Error(label);
}
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } }
async function directoryIdentity(path: string) { const stat = await lstat(path); return [stat.dev, stat.ino, stat.uid, stat.mode].join(":"); }
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-environment-driver-"))); await chmod(directory, 0o700);
  const originalState = join(directory, "original"), stateDirectory = join(directory, "manager");
  await mkdir(originalState, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
  const script = join(directory, "tcp-child.mjs"), data = join(originalState, "retained.data"), record = join(originalState, "original-record.json"), trace = join(directory, "trace.txt");
  await writeFile(script, SOURCE, { mode: 0o600 }); await writeFile(data, Buffer.from([0, 1, 255, 42, 0, 7]), { mode: 0o600 });
  await writeFile(record, '{"sealed":"original-evidence-retained"}\n', { mode: 0o600 }); await writeFile(trace, "", { mode: 0o600 });
  const originalBytes = { data: await readFile(data), record: await readFile(record) };
  const node = await native.pinFile(await realpath(process.execPath));
  const owned = new Map<number, Entry>(), releases = new Set<string>();
  const configs: Record<string, { witness: Witness; executable: Pin; cwd: string; args: string[]; env: Record<string, string>; port: number; uuid?: string; runId?: string }> = {};
  const state = { idle: true, checks: 0, phases: [] as string[], runIds: [] as (string | undefined)[], hookCalls: [] as string[] };
  async function launch(name: string) {
    const ready = join(directory, `${name}.ready`), release = join(directory, `${name}.release`); releases.add(release);
    const args = [script, name, "0", ready, trace, data, release], env = { PATH: "/usr/bin:/bin", FIXTURE_ONLY: name };
    const entry = await native.spawnOwned({ executable: node, args, cwd: directory, env, logPath: join(directory, `${name}.initial.log`) });
    owned.set(entry.witness.pid, entry);
    await until(() => exists(ready), `${name} fixture did not publish its listener`);
    const observed = JSON.parse(await readFile(ready, "utf8")) as { pid: number; port: number };
    expect(observed.pid).toBe(entry.witness.pid); await native.assertListener(observed.port, observed.pid);
    return { entry, args: [script, name, String(observed.port), ready, trace, data, release], env, port: observed.port };
  }
  try {
    const abandoned = await launch("prior-owner"); await native.stopOwned(abandoned.entry);
    for (const name of NAMES) {
      const child = await launch(name);
      configs[name] = { witness: child.entry.witness, executable: node, cwd: directory, args: child.args, env: child.env, port: child.port,
        ...(name === "mysql" ? { uuid: "fixture-preserved-mysql-uuid" } : {}), ...(name === "redis" ? { runId: INITIAL_RUN } : {}) };
    }
    const files = await Promise.all([script, data, record].map(async path => ({ path, sha256: (await native.pinFile(path)).sha256 })));
    const profile = { schema: "local-environment-profile-v1", stateDirectory, originalState, node, acceptedCommit: "1".repeat(40), files,
      directories: [{ path: originalState, identity: await directoryIdentity(originalState) }], abandonedControllers: [abandoned.entry.witness],
      roles: { router: configs.router, runner: configs.runner }, infrastructure: { mysql: configs.mysql, redis: configs.redis } };
    const profilePath = join(directory, "profile.json"); await native.writePrivateJson(profilePath, profile, { createOnly: true });
    const initialProfile = await readFile(profilePath), originalTrace = (await readFile(trace, "utf8")).split("\n").filter(Boolean).length;
    function bind(driver: Driver) {
      driver.setHooks({
        async beforeAction(selected, entries) { state.hookCalls.push(`before:${selected}`); state.runIds.push(entries.redis!.runId); },
        async checkIdle() { state.checks++; return state.idle; },
        async ready(name, entry) {
          if (entry.child && entry.closed) owned.set(entry.witness.pid, { child: entry.child, closed: entry.closed, witness: entry.witness });
          await until(async () => { try { await native.assertListener(entry.port, entry.witness.pid); return true; } catch { return false; } }, `${name} successor listener did not become ready`);
          state.hookCalls.push(`ready:${name}`);
        },
        async beforeInfrastructureStop(name) { state.hookCalls.push(`save-before-stop:${name}`); },
        async afterInfrastructureStart(entries) { state.hookCalls.push("after-infrastructure-start"); entries.redis!.runId = NEXT_RUN; return { redis: { runId: NEXT_RUN } }; },
      });
      return driver;
    }
    return { directory, originalState, stateDirectory, profilePath, profile, configs, state, data, record, trace,
      async driver() { return bind(await driverModule.createLocalEnvironmentDriver({ profilePath })); },
      async ledger() { return JSON.parse(await readFile(join(stateDirectory, "processes.json"), "utf8")) as { entries: Record<string, { witness: Witness; state: string; lastStop: { originalChildProcessCloseObserved: boolean } | null }>; infrastructureGeneration: unknown }; },
      async traceActions() { return (await readFile(trace, "utf8")).split("\n").filter(Boolean).slice(originalTrace); },
      async unchanged() { expect(await readFile(data)).toEqual(originalBytes.data); expect(await readFile(record)).toEqual(originalBytes.record); expect(await readFile(profilePath)).toEqual(initialProfile); },
      async close() {
        for (const release of releases) await writeFile(release, "fixture-release", { mode: 0o600 });
        for (const entry of owned.values()) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGTERM");
        await Promise.all([...owned.values()].map(entry => entry.closed));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const release of releases) await writeFile(release, "fixture-release", { mode: 0o600 });
    for (const entry of owned.values()) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGTERM");
    await Promise.all([...owned.values()].map(entry => entry.closed)); await rm(directory, { recursive: true, force: true }); throw error;
  }
}

// End-to-end native process ordering uses four tiny TCP children. Fake health
// hooks never connect to a database and never make provider/model requests.
describe("bound local environment driver restart and data continuity", () => {
  it("adopts exact witnesses, preserves data through a complete cold cycle and reloads without automatic actions", async () => {
    const f = await fixture();
    try {
      const driver = await f.driver(); expect((await driver.snapshot()).overall).toBe("ready");
      const old = await f.ledger();
      await driver.perform("stop-services");
      const stoppedServices = await f.ledger();
      for (const name of ["router", "runner"]) expect(stoppedServices.entries[name]?.lastStop?.originalChildProcessCloseObserved).toBe(false);
      await driver.perform("stop-infrastructure");
      expect((await driver.snapshot()).overall).toBe("stopped");
      await driver.perform("start-infrastructure");
      await driver.perform("start-services");
      expect((await driver.snapshot()).overall).toBe("ready");
      expect(await f.traceActions()).toEqual(["router:stop", "runner:stop", "redis:stop", "mysql:stop", "mysql:start", "redis:start", "runner:start", "router:start"]);
      const restarted = await f.ledger();
      for (const name of NAMES) expect(restarted.entries[name]?.witness.pid).not.toBe(old.entries[name]?.witness.pid);
      expect(f.state.runIds.at(-1)).toBe(NEXT_RUN);
      expect(restarted.infrastructureGeneration).not.toBeNull(); await f.unchanged();
      await driver.perform("stop-services"); await driver.perform("stop-infrastructure");
      const closed = await f.ledger();
      for (const name of NAMES) expect(closed.entries[name]?.lastStop?.originalChildProcessCloseObserved).toBe(true);
      const actionsBeforeReload = await f.traceActions(), witnesses = Object.fromEntries(NAMES.map(name => [name, closed.entries[name]?.witness]));
      const reloaded = await f.driver(); expect((await reloaded.snapshot()).overall).toBe("stopped");
      const readBack = await f.ledger(); expect(Object.fromEntries(NAMES.map(name => [name, readBack.entries[name]?.witness]))).toEqual(witnesses);
      expect(await f.traceActions()).toEqual(actionsBeforeReload); await f.unchanged();
    } finally { await f.close(); }
  }, 120_000);

  it("blocks a service shutdown while work is active and leaves every original process alive", async () => {
    const f = await fixture();
    try {
      const driver = await f.driver(); f.state.idle = false;
      const signal = vi.spyOn(process, "kill");
      try {
        await expect(driver.perform("stop-services")).rejects.toThrow("environment_not_idle");
        expect(signal.mock.calls.filter(([, selected]) => selected !== 0)).toEqual([]);
      } finally { signal.mockRestore(); }
      expect(await f.traceActions()).toEqual([]);
      expect(NAMES.every(name => alive(f.configs[name]!.witness.pid))).toBe(true);
      expect((await driver.snapshot()).overall).toBe("ready"); await f.unchanged();
    } finally { await f.close(); }
  }, 60_000);

  it("keeps an unresolved ledger entry unknown after reload and disables all lifecycle actions", async () => {
    const f = await fixture();
    try {
      await f.driver(); const path = join(f.stateDirectory, "processes.json"), ledger = await f.ledger();
      ledger.entries.router!.state = "stopping";
      await native.writePrivateJson(path, ledger);
      const reloaded = await f.driver(), snapshot = await reloaded.snapshot();
      expect(snapshot.overall).toBe("unknown"); expect(snapshot.components.find(item => item.id === "router")?.state).toBe("unknown");
      expect(Object.values(reloaded.capabilities(snapshot)).every(item => !item.enabled)).toBe(true);
      await expect(reloaded.perform("stop-services")).rejects.toThrow("environment_action_disabled");
      expect(NAMES.every(name => alive(f.configs[name]!.witness.pid))).toBe(true);
      expect(await f.traceActions()).toEqual([]); await f.unchanged();
    } finally { await f.close(); }
  }, 60_000);
});
