import type { ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Pin = { path: string; dev: number; ino: number; size: number; sha256: string };
type Witness = { pid: number; pgid: number; uid: number; started: string; executable: Pin };
type Entry = { witness: Witness; child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };
type SpawnSpec = { executable: Pin; args: string[]; cwd: string; env: Record<string, string>; logPath: string };
type Started = { url: string; reused: boolean; controlConfigPath: string };
let native: { pinFile(path: string): Promise<Pin>; spawnOwned(options: SpawnSpec): Promise<Entry>;
  stopOwned(entry: Entry, options?: { timeoutMs?: number }): Promise<{ originalChildProcessCloseObserved: boolean }>;
  writePrivateJson(path: string, value: unknown, options?: { createOnly?: boolean }): Promise<unknown> };
let experience: { startChatExperience(options: { configPath: string }, dependencies?: { spawnRuntime(options: SpawnSpec): Promise<Entry> }): Promise<Started> };
beforeAll(async () => {
  native = await import(new URL("../scripts/ops/local-environment-native.mjs", import.meta.url).href) as typeof native;
  experience = await import(new URL("../scripts/ops/chat-experience.mjs", import.meta.url).href) as typeof experience;
});

const USER = "manual_startup_fixture_owner", KEY = "manual-startup-fixture-no-provider-key";
const AGENT = "agt_00000000-0000-7000-8000-000000000001", SESSION = "sess_00000000-0000-7000-8000-000000000002";
const SEED = { session: { id: SESSION, userId: USER, agentId: AGENT, agentVersion: 1, title: "原数据保留", status: { type: "idle" } },
  items: [{ id: "item_00000000-0000-7000-8000-000000000003", sessionId: SESSION, seq: 1, type: "agentMessage", status: "completed", text: "重启前保存的合成回答" }] };

async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture missing listener");
  return address.port;
}
async function closeServer(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
async function get(url: string, token?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((done, reject) => {
    const outgoing = request(url, { method: "GET", agent: false, headers: token ? { "X-Chat-Token": token } : {} }, incoming => {
      const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(Buffer.from(chunk))); incoming.once("error", reject);
      incoming.once("end", () => {
        try { done({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); }
      });
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error("fixture request timeout"))); outgoing.once("error", reject); outgoing.end();
  });
}

async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function until(predicate: () => Promise<boolean>, label: string, milliseconds = 10_000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>(done => setTimeout(done, 20));
  }
  throw new Error(label);
}

async function fixture(startupGate: "none" | "owner" | "h5" = "none") {
  const base = process.platform === "darwin" ? "/private/tmp" : await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(base, "as-chat-up-"))); await chmod(directory, 0o700);
  const originalState = join(directory, "original"), manager = join(directory, "manager"), stateDirectory = join(directory, "launcher");
  for (const path of [originalState, manager, stateDirectory]) await mkdir(path, { mode: 0o700 });
  const data = join(originalState, "session.json"), oldLock = join(originalState, "owner.lock"), oldClient = join(originalState, "control.json");
  const trace = join(directory, "lifecycle.jsonl"), release = join(directory, "fixture.release");
  const startupRelease = join(directory, "startup.release"), startupEntered = join(directory, "startup.entered"), cancellationObserved = join(directory, "startup.cancelled");
  const ownerClosed = join(directory, "owner.closed"), h5Closed = join(directory, "h5.closed");
  await writeFile(data, JSON.stringify(SEED), { mode: 0o600 }); await writeFile(oldLock, "retained-original-lock\n", { mode: 0o600 });
  await writeFile(oldClient, '{"retained":"original-client-evidence"}\n', { mode: 0o600 }); await writeFile(trace, "", { mode: 0o600 });
  const seen: { method: string; path: string }[] = [];
  // The only upstream is a read-only, deterministic HTTP fixture. A POST is
  // recorded and rejected, making any accidental turn/model dispatch visible.
  const backend = createServer((incoming, outgoing) => {
    const path = incoming.url ?? "/", method = incoming.method ?? ""; seen.push({ method, path });
    let value: unknown, status = 200;
    if (method !== "GET") { status = 405; value = { error: "fixture_read_only_no_model" }; }
    else if (path === "/readyz") value = { ready: true };
    else if (incoming.headers.authorization !== `Bearer ${KEY}` || incoming.headers["x-user-id"] !== USER) { status = 401; value = { error: "fixture_auth_rejected" }; }
    else {
      const seed = JSON.parse(requireFixtureData());
      if (path === `/v1/sessions/${SESSION}`) value = seed.session;
      else if (path.startsWith(`/v1/sessions/${SESSION}/items`)) value = { data: seed.items };
      else { status = 404; value = { error: "fixture_unknown_resource" }; }
    }
    outgoing.writeHead(status, { "content-type": "application/json", connection: "close" }); outgoing.end(JSON.stringify(value));
  });
  // The fixture data is loaded before requests, then read through an unchanged
  // byte string. The persistence hash assertions below use the actual file.
  const dataBytes = await readFile(data), requireFixtureData = () => dataBytes.toString("utf8");
  const backendPort = await listen(backend), reservation = createServer();
  const h5Port = await listen(reservation); await closeServer(reservation);
  const node = await native.pinFile(await realpath(process.execPath));
  const profilePath = join(directory, "profile.json"), clientConfigPath = join(directory, "client.json"), configPath = join(directory, "launch.json");
  await native.writePrivateJson(profilePath, { schema: "local-environment-profile-v1", stateDirectory: manager, originalState, node }, { createOnly: true });
  await native.writePrivateJson(clientConfigPath, { BASE_URL: `http://127.0.0.1:${backendPort}`, SERVICE_API_KEY: KEY, USER_ID: USER,
    AGENT_ID: AGENT, AGENT_VERSION: "1", MODEL_CALL_ACK: "allow-model-calls-v1", REQUEST_TIMEOUT_MS: "1000", OPERATION_TIMEOUT_MS: "5000" }, { createOnly: true });
  await native.writePrivateJson(configPath, { schema: "chat-experience-launch-v1", profilePath, clientConfigPath,
    initialControlConfigPath: oldClient, stateDirectory, port: h5Port, controlParentDirectory: base }, { createOnly: true });
  const script = join(directory, "runtime-fixture.mjs");
  const runtimeUrl = new URL("../scripts/ops/chat-experience-runtime.mjs", import.meta.url).href;
  const ownerUrl = new URL("../scripts/ops/local-environment-owner.mjs", import.meta.url).href;
  const h5Url = new URL("../scripts/ops/chat-h5.mjs", import.meta.url).href;
  const source = `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { runChatExperienceRuntime } from ${JSON.stringify(runtimeUrl)};
import { runEnvironmentOwner } from ${JSON.stringify(ownerUrl)};
import { createChatH5Server } from ${JSON.stringify(h5Url)};
const [flag, requestPath, trace, release, mode, startupRelease, startupEntered, cancellationObserved, ownerClosed, h5Closed] = process.argv.slice(2);
if (flag !== "--request") throw new Error("fixture_request_invalid");
process.once("SIGTERM", () => writeFileSync(cancellationObserved, "native SIGTERM observed", { mode: 0o600 }));
async function waitForStartupGate() {
  writeFileSync(startupEntered, mode, { mode: 0o600 });
  while (!existsSync(startupRelease)) await new Promise(done => setTimeout(done, 20));
}
const names = ["owner", "router", "runner", "mysql", "redis"];
const states = Object.fromEntries(names.map(name => [name, name === "owner" ? "ready" : "stopped"]));
const driver = {
  async snapshot() {
    const all = names.slice(1).map(name => states[name]);
    return { overall: all.every(value => value === "ready") ? "ready" : all.every(value => value === "stopped") ? "stopped" : "partial",
      components: names.map(id => ({ id, name: id, state: states[id], pid: process.pid })) };
  },
  async checkIdle() { return true; }, setHooks() {}, detach() {},
  async perform(action) {
    appendFileSync(trace, JSON.stringify({ action, pid: process.pid }) + "\\n");
    if (!["start-infrastructure", "start-services"].includes(action)) throw new Error("fixture_action_invalid");
    for (const name of action === "start-infrastructure" ? ["mysql", "redis"] : ["runner", "router"]) states[name] = "ready";
  }
};
let application;
const gate = setInterval(() => { if (existsSync(release)) { clearInterval(gate); void application?.close(); } }, 20);
try {
  application = await runChatExperienceRuntime({ requestPath }, {
    prepareBoot: async () => {},
    runOwner: async options => {
      const application = await runEnvironmentOwner({ ...options, driverFactory: async () => driver, hooksFactory: async () => ({}) });
      if (mode === "owner") await waitForStartupGate();
      return { ...application, async close() { await application.close(); writeFileSync(ownerClosed, "closed", { mode: 0o600 }); } };
    },
    startH5: async options => {
      const application = await createChatH5Server(options);
      if (mode === "h5") await waitForStartupGate();
      return { ...application, async close() { await application.close(); writeFileSync(h5Closed, "closed", { mode: 0o600 }); } };
    }
  });
} catch (error) {
  clearInterval(gate); await error.retainedRuntime?.close();
  if (error.code !== "chat_experience_start_cancelled_retained") throw error;
}
process.once("SIGTERM", () => clearInterval(gate));
`;
  await writeFile(script, source, { mode: 0o600 });
  const retained = await Promise.all([data, oldLock, oldClient, profilePath, clientConfigPath, configPath].map(path => readFile(path)));
  const children: Entry[] = [], controlDirectories = new Set<string>(), umask = process.umask();
  const spawnRuntime = vi.fn(async (spec: SpawnSpec) => {
    const entry = await native.spawnOwned({ ...spec, args: [script, "--request", spec.args[2]!, trace, release,
      startupGate, startupRelease, startupEntered, cancellationObserved, ownerClosed, h5Closed] }); children.push(entry); return entry;
  });
  return { directory, stateDirectory, configPath, h5Port, data, oldLock, oldClient, backend, seen, children, spawnRuntime, trace,
    startupRelease, startupEntered, cancellationObserved, ownerClosed, h5Closed,
    async start() {
      const result = await experience.startChatExperience({ configPath }, { spawnRuntime });
      const control = JSON.parse(await readFile(result.controlConfigPath, "utf8")); controlDirectories.add(dirname(control.socketPath));
      return result;
    },
    async unchanged() { expect(await Promise.all([data, oldLock, oldClient, profilePath, clientConfigPath, configPath].map(path => readFile(path)))).toEqual(retained); },
    async close() {
      try {
        await writeFile(startupRelease, "fixture-only-startup-release", { mode: 0o600 });
        await writeFile(release, "fixture-only-release", { mode: 0o600 });
        for (const attempt of (await readdir(stateDirectory)).filter(name => name.startsWith("attempt-"))) {
          const config = join(stateDirectory, attempt, "control.json");
          if (await exists(config)) controlDirectories.add(dirname(JSON.parse(await readFile(config, "utf8")).socketPath));
        }
        for (const entry of children) {
          const receipt = await native.stopOwned(entry, { timeoutMs: 15_000 }); expect(receipt.originalChildProcessCloseObserved).toBe(true);
          await entry.closed;
        }
        await closeServer(backend);
        // These exact private control paths were published by this fixture's
        // accepted runtime. Never select or delete arbitrary tmp directories.
        for (const path of controlDirectories) await rm(path, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
      } finally { process.umask(umask); }
    },
  };
}

describe("manual one-command launcher with detached native runtime", () => {
  it("starts OWNER and H5, reuses a live runtime, then restores retained chat after a full runtime exit without POST", async () => {
    const f = await fixture();
    try {
      const first = await f.start(); expect(first.reused).toBe(false); expect(first.url).toBe(`http://127.0.0.1:${f.h5Port}/`);
      expect(f.children).toHaveLength(1); const child = f.children[0]!;
      expect(child.witness.pid).toBe(child.child.pid); expect(child.witness.pgid).toBe(child.child.pid);
      const current = await readFile(join(f.stateDirectory, "current.json"));
      const receipt = JSON.parse(current.toString("utf8")); expect(receipt.owner).toEqual(child.witness); expect(receipt.h5).toEqual(child.witness);
      const bootstrap = await get(first.url + "api/config"); expect(bootstrap.status).toBe(200);
      const token = String(bootstrap.body.csrfToken);
      expect((await get(first.url + `api/sessions/${SESSION}`, token)).body).toEqual(SEED.session);
      expect((await get(first.url + `api/sessions/${SESSION}/items?limit=200`, token)).body).toEqual({ data: SEED.items });
      const second = await f.start(); expect(second).toMatchObject({ url: first.url, reused: true, controlConfigPath: first.controlConfigPath });
      expect(f.spawnRuntime).toHaveBeenCalledOnce(); expect(f.children).toHaveLength(1);
      expect(await readFile(join(f.stateDirectory, "current.json"))).toEqual(current);
      expect((await readFile(f.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line).action)).toEqual(["start-infrastructure", "start-services"]);
      const firstControlBytes = await readFile(first.controlConfigPath);
      const stopped = await native.stopOwned(child, { timeoutMs: 15_000 }); expect(stopped.originalChildProcessCloseObserved).toBe(true);
      await child.closed;
      const restored = await f.start(); expect(restored.reused).toBe(false); expect(restored.url).toBe(first.url);
      expect(f.children).toHaveLength(2); expect(f.children[1]!.witness.pid).not.toBe(child.witness.pid);
      const restoredBootstrap = await get(restored.url + "api/config"), restoredToken = String(restoredBootstrap.body.csrfToken);
      expect((await get(restored.url + `api/sessions/${SESSION}`, restoredToken)).body).toEqual(SEED.session);
      expect((await get(restored.url + `api/sessions/${SESSION}/items?limit=200`, restoredToken)).body).toEqual({ data: SEED.items });
      expect(await readFile(first.controlConfigPath)).toEqual(firstControlBytes);
      expect((await readFile(f.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line).action))
        .toEqual(["start-infrastructure", "start-services", "start-infrastructure", "start-services"]);
      expect(f.seen.filter(row => row.method !== "GET")).toEqual([]);
      expect((await readdir(f.stateDirectory)).filter(name => name.startsWith("start-") && name.endsWith(".lock"))).toEqual([]);
      expect((await lstat(first.controlConfigPath)).mode & 0o777).toBe(0o600); await f.unchanged();
    } finally { await f.close(); }
  }, 90_000);

  it("refuses an unrelated H5 listener without starting a runtime or signaling its owner", async () => {
    const f = await fixture(), occupied = createServer((_request, response) => response.end("unrelated fixture"));
    await new Promise<void>((done, reject) => { occupied.once("error", reject); occupied.listen(f.h5Port, "127.0.0.1", done); });
    const signal = vi.spyOn(process, "kill");
    try {
      await expect(f.start()).rejects.toThrow("chat_experience_port_in_use");
      expect(f.spawnRuntime).not.toHaveBeenCalled(); expect(occupied.listening).toBe(true);
      expect(signal.mock.calls.filter(([, selected]) => selected !== 0)).toEqual([]);
      expect((await readdir(f.stateDirectory)).filter(name => name.startsWith("attempt-"))).toEqual([]); await f.unchanged();
    } finally { signal.mockRestore(); await closeServer(occupied); await f.close(); }
  }, 30_000);

  it("retains an unresolved startup intent and never launches another runtime", async () => {
    const f = await fixture();
    try {
      const pending = join(f.stateDirectory, "pending.json"), bytes = '{"schema":"chat-experience-pending-v1","state":"intent","requestPath":"retained-fixture-request"}\n';
      await writeFile(pending, bytes, { mode: 0o600 });
      await expect(f.start()).rejects.toThrow("chat_experience_unknown_retained");
      expect(f.spawnRuntime).not.toHaveBeenCalled(); expect(await readFile(pending, "utf8")).toBe(bytes);
      expect(f.seen).toEqual([]); await f.unchanged();
    } finally { await f.close(); }
  }, 30_000);

  it.each(["owner", "h5"] as const)("closes a late %s resource after SIGTERM without publishing readiness or accepting more startup work", async mode => {
    const f = await fixture(mode);
    // The runtime fixture pauses only after the real resource exists, before its
    // promise returns. This reproduces a signal during an in-flight factory.
    const starting = f.start().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
      await until(() => exists(f.startupEntered), `runtime did not reach delayed ${mode} factory`);
      expect(f.children).toHaveLength(1); const child = f.children[0]!;
      const stopping = native.stopOwned(child, { timeoutMs: 15_000 });
      await until(() => exists(f.cancellationObserved), "fixture did not observe native cancellation");
      await writeFile(f.startupRelease, "resolve delayed resource after cancellation", { mode: 0o600 });
      expect((await stopping).originalChildProcessCloseObserved).toBe(true); await child.closed;
      const outcome = await starting; expect(outcome.value).toBeUndefined(); expect(outcome.error).toBeInstanceOf(Error);
      expect(await exists(f.ownerClosed)).toBe(true);
      expect(await exists(f.h5Closed)).toBe(mode === "h5");
      const actions = (await readFile(f.trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line).action);
      expect(actions).toEqual(mode === "owner" ? [] : ["start-infrastructure", "start-services"]);
      expect(await exists(join(f.stateDirectory, "current.json"))).toBe(false);
      for (const attempt of (await readdir(f.stateDirectory)).filter(name => name.startsWith("attempt-"))) {
        const result = JSON.parse(await readFile(join(f.stateDirectory, attempt, "result.json"), "utf8"));
        expect(result.state).toBe("failed"); expect(result.code).toBe("chat_experience_start_cancelled_retained");
      }
      expect(f.seen.filter(row => row.method !== "GET")).toEqual([]); await f.unchanged();
    } finally { await f.close(); await starting; }
  }, 60_000);
});
