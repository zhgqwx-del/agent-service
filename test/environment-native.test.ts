import type { ChildProcess } from "node:child_process";
import { chmod, copyFile, lstat, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Pin = { path: string; dev: number; ino: number; size: number; sha256: string };
type Witness = { pid: number; pgid: number; uid: number; started: string; executable: Pin };
type Closed = { code: number | null; signal: NodeJS.Signals | null };
type Entry = { child: ChildProcess; witness: Witness; closed: Promise<Closed> };
type Receipt = { signalRequested: boolean; signal: "SIGTERM" | null; processAbsent: boolean; processGroupAbsent: boolean;
  originalChildProcessCloseObserved: boolean; childClose: Closed | null; witness: Witness };
let native: {
  readPrivateJson(path: string): Promise<{ value: unknown; sha256: string }>;
  writePrivateJson(path: string, value: unknown, options?: { createOnly?: boolean }): Promise<{ sha256: string }>;
  pinFile(path: string): Promise<Pin>;
  processIdentity(pid: number, executable: Pin | string): Promise<Witness>;
  sameProcess(witness: Witness): Promise<Witness>;
  processAbsent(witness: Witness): Promise<boolean>;
  assertListener(port: number, pid: number): Promise<void>;
  spawnOwned(spec: { executable: Pin | string; args: string[]; cwd: string; env: Record<string, string>; logPath: string }): Promise<Entry>;
  stopOwned(entry: { witness: Witness; child?: ChildProcess; closed?: Promise<Closed> }, options?: { timeoutMs?: number }): Promise<Receipt>;
  safeCode(error: unknown): string;
};
beforeAll(async () => {
  native = await import(new URL("../scripts/ops/local-environment-native.mjs", import.meta.url).href) as typeof native;
});

const CHILD = `import { existsSync, writeFileSync } from "node:fs";
const [ready, stopped, release, mode] = process.argv.slice(2);
process.on("SIGTERM", () => {
  writeFileSync(stopped, "normal-term-observed", { mode: 0o600 });
  if (mode !== "hold") process.exit(0);
});
writeFileSync(ready, "fixture-ready", { mode: 0o600 });
setInterval(() => { if (existsSync(release)) process.exit(0); }, 20);
`;
async function until(predicate: () => Promise<boolean>, label: string, milliseconds = 5_000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>(done => setTimeout(done, 10));
  }
  throw new Error(label);
}
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } }
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-environment-native-")));
  await chmod(directory, 0o700);
  const executable = await realpath(process.execPath), script = join(directory, "child.mjs");
  await writeFile(script, CHILD, { mode: 0o600 });
  const children: { entry: Entry; release: string }[] = [];
  return { directory, executable, script,
    async launch(mode = "normal", selectedExecutable: string | Pin = executable) {
      const label = `fixture-${children.length}`, ready = join(directory, `${label}.ready`), stopped = join(directory, `${label}.stopped`), release = join(directory, `${label}.release`);
      const logPath = join(directory, `${label}.log`);
      const entry = await native.spawnOwned({ executable: selectedExecutable, args: [script, ready, stopped, release, mode],
        cwd: directory, env: { PATH: "/usr/bin:/bin", FIXTURE_ONLY: "no-ambient-config" }, logPath });
      children.push({ entry, release });
      await until(() => exists(ready), "native fixture did not install its TERM handler");
      return { entry, ready, stopped, release, logPath };
    },
    async close() {
      // These handles were created by this fixture. Cleanup never selects a PID
      // from a journal, never removes external directories and never force kills.
      for (const { entry, release } of children) {
        await writeFile(release, "fixture-only-exit", { mode: 0o600 });
        if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGTERM");
      }
      await Promise.all(children.map(({ entry }) => entry.closed));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing native fixture listener");
  return address.port;
}

// Real temporary Node children prove native identity and close observations. They
// do not start MySQL, Redis, product services, read .env or call a model provider.
describe("local environment native process and private file boundaries", () => {
  it("pins a real child and observes its accepted ChildProcess close after normal TERM", async () => {
    const f = await fixture();
    try {
      const child = await f.launch(), { entry } = child;
      expect(entry.witness.pid).toBe(entry.child.pid); expect(entry.witness.pgid).toBe(entry.child.pid);
      expect(entry.witness.executable.path).toBe(f.executable);
      expect(await native.sameProcess(entry.witness)).toEqual(entry.witness);
      expect(await native.processAbsent(entry.witness)).toBe(false);
      expect((await lstat(child.logPath)).mode & 0o777).toBe(0o600);
      const receipt = await native.stopOwned(entry);
      expect(receipt).toMatchObject({ signalRequested: true, signal: "SIGTERM", processAbsent: true, processGroupAbsent: true,
        originalChildProcessCloseObserved: true, childClose: { code: 0, signal: null }, witness: entry.witness });
      expect(await readFile(child.stopped, "utf8")).toBe("normal-term-observed");
      expect(await native.processAbsent(entry.witness)).toBe(true);
    } finally { await f.close(); }
  });

  it("labels a witnessed orphan stop without inventing an original ChildProcess close", async () => {
    const f = await fixture();
    try {
      const { entry } = await f.launch();
      const receipt = await native.stopOwned({ witness: entry.witness });
      expect(receipt).toMatchObject({ signal: "SIGTERM", processAbsent: true, processGroupAbsent: true,
        originalChildProcessCloseObserved: false, childClose: null });
      await entry.closed;
    } finally { await f.close(); }
  });

  it("rejects a reused-PID-shaped witness before signaling the still-live child", async () => {
    const f = await fixture();
    try {
      const { entry, stopped } = await f.launch();
      const changed = { ...entry.witness, started: `${entry.witness.started} changed` };
      const signal = vi.spyOn(process, "kill");
      try {
        await expect(native.stopOwned({ ...entry, witness: changed })).rejects.toThrow("process_identity_changed");
        expect(signal.mock.calls.filter(([, value]) => value !== 0)).toEqual([]);
      } finally { signal.mockRestore(); }
      expect(alive(entry.witness.pid)).toBe(true); expect(await exists(stopped)).toBe(false);
    } finally { await f.close(); }
  });

  it("refuses a changed executable pin without signaling the original child", async () => {
    const f = await fixture();
    try {
      const selected = join(f.directory, "fixture-node"), replacement = join(f.directory, "replacement-node");
      await copyFile(f.executable, selected); await chmod(selected, 0o700);
      const pin = await native.pinFile(selected), { entry, stopped } = await f.launch("normal", pin);
      await copyFile(f.executable, replacement); await chmod(replacement, 0o700); await rename(replacement, selected);
      const signal = vi.spyOn(process, "kill");
      try {
        await expect(native.stopOwned(entry)).rejects.toThrow("file_pin_changed");
        expect(signal.mock.calls.filter(([, value]) => value !== 0)).toEqual([]);
      } finally { signal.mockRestore(); }
      expect(alive(entry.witness.pid)).toBe(true); expect(await exists(stopped)).toBe(false);
    } finally { await f.close(); }
  });

  it("does not recognize an unrelated process merely because it owns the selected listener", async () => {
    const f = await fixture(), server = createServer();
    try {
      const { entry } = await f.launch(), port = await listen(server);
      await expect(native.assertListener(port, entry.witness.pid)).rejects.toThrow("listener_identity_mismatch");
      await native.assertListener(port, process.pid);
      expect(alive(entry.witness.pid)).toBe(true);
    } finally {
      if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await f.close();
    }
  });

  it("retains a child that exceeds graceful stop and never escalates beyond TERM", async () => {
    const f = await fixture();
    try {
      const { entry, stopped } = await f.launch("hold"), signal = vi.spyOn(process, "kill");
      try {
        await expect(native.stopOwned(entry, { timeoutMs: 500 })).rejects.toThrow("process_stop_timeout_retained");
        expect(signal.mock.calls.filter(([, value]) => value !== 0).map(([, value]) => value)).toEqual(["SIGTERM"]);
      } finally { signal.mockRestore(); }
      expect(alive(entry.witness.pid)).toBe(true); expect(await readFile(stopped, "utf8")).toBe("normal-term-observed");
    } finally { await f.close(); }
  });

  it("does not substitute a missing close observer for an accepted child handle", async () => {
    const f = await fixture();
    try {
      const { entry } = await f.launch();
      await expect(native.stopOwned({ witness: entry.witness, child: entry.child })).rejects.toThrow("owned_process_invalid");
      expect(alive(entry.witness.pid)).toBe(true);
    } finally { await f.close(); }
  });

  it("writes owner-only JSON create-only and retains the first value on a duplicate write", async () => {
    const f = await fixture(), path = join(f.directory, "private.json");
    try {
      const first = await native.writePrivateJson(path, { retained: "original-fixture-value" }, { createOnly: true });
      const original = await readFile(path), observed = await native.readPrivateJson(path);
      expect(observed).toEqual({ value: { retained: "original-fixture-value" }, sha256: first.sha256 });
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      await expect(native.writePrivateJson(path, { retained: "replacement" }, { createOnly: true })).rejects.toThrow("private_json_target_exists");
      expect(await readFile(path)).toEqual(original);
    } finally { await f.close(); }
  });

  it.each(["public_file", "public_parent", "symlink"])("refuses %s private JSON on reads and writes", async fault => {
    const f = await fixture(), path = join(f.directory, "private.json"), target = join(f.directory, "target.json");
    try {
      await writeFile(path, '{"retained":"original"}', { mode: 0o600 });
      if (fault === "public_file") await chmod(path, 0o644);
      if (fault === "public_parent") await chmod(f.directory, 0o755);
      if (fault === "symlink") { await rename(path, target); await symlink(target, path); }
      await expect(native.readPrivateJson(path)).rejects.toThrow(fault === "public_parent" ? "private_directory_required" : "private_file_required");
      await expect(native.writePrivateJson(path, { replaced: true })).rejects.toThrow(fault === "public_parent" ? "private_directory_required" : "private_file_required");
      expect(await readFile(fault === "symlink" ? target : path, "utf8")).toBe('{"retained":"original"}');
    } finally { await f.close(); }
  });

  it("maps unknown native diagnostics to a fixed public failure code", () => {
    expect(native.safeCode(new Error("provider-key-or-raw-native-output"))).toBe("native_operation_failed");
    expect(native.safeCode(new Error("process_identity_changed"))).toBe("process_identity_changed");
    expect(native.safeCode("process_identity_changed")).toBe("native_operation_failed");
  });
});
