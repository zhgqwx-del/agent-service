import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type Pin = { path: string; dev: number; ino: number; size: number; sha256: string };
type Witness = { pid: number; pgid: number; uid: number; started: string; executable: Pin };
type Entry = { witness: Witness; child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };
type HookEntry = { witness: Witness; child?: ChildProcess; closed?: Entry["closed"]; port: number; state: string; runId?: string };
type EnvironmentStatus = { overall: string; components: { id: string; state: string }[];
  operation: { id: string; action: string; state: string; error: string | null } | null };
type EnvironmentController = { status(): Promise<EnvironmentStatus>; act(input: unknown): Promise<unknown>; close(): Promise<void> };
type Hooks = { beforeAction(action: string, entries: Record<string, HookEntry>): Promise<void>;
  checkIdle(entries: Record<string, HookEntry>): Promise<boolean>; ready(name: string, entry: HookEntry): Promise<void>;
  beforeInfrastructureStop(name: string, entry: HookEntry): Promise<void>;
  afterInfrastructureStart(entries: Record<string, HookEntry>): Promise<{ redis: { runId: string } }> };
type Driver = { setHooks(hooks: Hooks): void; detach(): void };
let native: { pinFile(path: string): Promise<Pin>; assertListener(port: number, pid: number): Promise<void>;
  spawnOwned(spec: { executable: Pin; args: string[]; cwd: string; env: Record<string, string>; logPath: string }): Promise<Entry>;
  stopOwned(entry: Entry): Promise<unknown>; writePrivateJson(path: string, value: unknown, options?: { createOnly?: boolean }): Promise<unknown> };
let driverModule: { createLocalEnvironmentDriver(options: { profilePath: string }): Promise<Driver> };
let ownerModule: { connectEnvironmentController(path: string): Promise<EnvironmentController>;
  runEnvironmentOwner(options: { profilePath: string; clientPath: string; controlDirectory: string;
    driverFactory(options: { profilePath: string }): Promise<Driver>; hooksFactory(profile: unknown): Promise<Hooks> }):
    Promise<{ controller: EnvironmentController; driver: Driver; close(): Promise<void> }> };
let chatModule: { createChatH5Server(options: { configPath: string; port: number; environmentController: EnvironmentController }):
  Promise<{ url: string; server: Server; close(): Promise<void> }> };
beforeAll(async () => {
  native = await import(new URL("../scripts/ops/local-environment-native.mjs", import.meta.url).href) as typeof native;
  driverModule = await import(new URL("../scripts/ops/local-environment-driver.mjs", import.meta.url).href) as typeof driverModule;
  ownerModule = await import(new URL("../scripts/ops/local-environment-owner.mjs", import.meta.url).href) as typeof ownerModule;
  chatModule = await import(new URL("../scripts/ops/chat-h5.mjs", import.meta.url).href) as typeof chatModule;
});

const USER = "environment_recovery_fixture_owner", SECRET = "environment-recovery-fixture-key-no-provider";
const AGENT = "agt_00000000-0000-7000-8000-000000000001";
const SID = "sess_00000000-0000-7000-8000-000000000002";
const TURN = "turn_00000000-0000-7000-8000-000000000003";
const INITIAL_RUN = "a".repeat(40), NEXT_RUN = "b".repeat(40);
const NAMES = ["runner", "router", "mysql", "redis"];
const SEED = {
  session: { id: SID, userId: USER, agentId: AGENT, agentVersion: 1, title: "重启恢复合成会话", status: { type: "idle" } },
  turn: { id: TURN, sessionId: SID, status: "completed", stopReason: "end_turn", steps: 1, toolCalls: 0 },
  items: [
    { id: "item_00000000-0000-7000-8000-000000000004", sessionId: SID, turnId: TURN, seq: 1, type: "userMessage", status: "completed",
      content: [{ type: "text", text: "请记住重启前项目代号青禾。" }], createdAtMs: 1_800_000_000_001, completedAtMs: 1_800_000_000_001 },
    { id: "item_00000000-0000-7000-8000-000000000005", sessionId: SID, turnId: TURN, seq: 2, type: "agentMessage", status: "completed",
      phase: "finalAnswer", text: "项目代号是青禾。这是预置持久结果。", createdAtMs: 1_800_000_000_002, completedAtMs: 1_800_000_000_002 },
  ],
};

// Every product-looking endpoint below is a deterministic, read-only fixture.
// Router forwards to the runner; only the runner reads the persisted seed file.
const CHILD_SOURCE = String.raw`import { createServer as httpServer, request } from "node:http";
import { createServer as tcpServer } from "node:net";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [name, selectedPort, ready, lifecycle, data, release, runnerPort, requests] = process.argv.slice(2);
function json(response, status, body) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
function record(incoming) { appendFileSync(requests, JSON.stringify({ role: name, method: incoming.method, path: incoming.url }) + "\n"); }
const server = name === "router" || name === "runner" ? httpServer((incoming, response) => {
  record(incoming);
  const url = new URL(incoming.url, "http://fixture");
  if (url.pathname === "/readyz") return json(response, 200, { ready: true });
  if (name === "router") {
    const outgoing = request({ hostname: "127.0.0.1", port: Number(runnerPort), method: incoming.method, path: incoming.url,
      headers: incoming.headers, agent: false }, upstream => { response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response); });
    outgoing.on("error", () => { if (!response.headersSent) json(response, 502, { error: "fixture_runner_unavailable" }); else response.destroy(); });
    incoming.pipe(outgoing); return;
  }
  if (incoming.headers.authorization !== "Bearer " + process.env.FIXTURE_SERVICE_KEY || incoming.headers["x-user-id"] !== process.env.FIXTURE_USER)
    return json(response, 401, { error: "fixture_auth_rejected" });
  if (incoming.method !== "GET") return json(response, 405, { error: "fixture_read_only_no_turn_dispatch" });
  const seed = JSON.parse(readFileSync(data, "utf8")), base = "/v1/sessions/" + seed.session.id;
  if (url.pathname === "/v1/sessions") return json(response, 200, { data: [seed.session], nextCursor: null });
  if (url.pathname === base) return json(response, 200, seed.session);
  if (url.pathname === base + "/items") {
    const after = Number(url.searchParams.get("afterSeq") ?? -1), limit = Number(url.searchParams.get("limit") ?? 200);
    return json(response, 200, { data: seed.items.filter(item => item.seq > after).slice(0, limit) });
  }
  if (url.pathname === base + "/turns") return json(response, 200, { data: [seed.turn], nextCursor: null });
  if (url.pathname === base + "/turns/" + seed.turn.id) return json(response, 200, seed.turn);
  return json(response, 404, { error: "fixture_unknown_resource" });
}) : tcpServer(socket => socket.end());
let closing = false;
function close() { if (closing) return; closing = true; appendFileSync(lifecycle, name + ":stop\n"); server.close(() => process.exit(0)); }
process.on("SIGTERM", close);
server.listen(Number(selectedPort), "127.0.0.1", () => {
  writeFileSync(ready, JSON.stringify({ pid: process.pid, port: server.address().port }), { mode: 0o600 });
  appendFileSync(lifecycle, name + ":start\n");
});
setInterval(() => { if (existsSync(release)) close(); }, 20);
`;

async function until(predicate: () => Promise<boolean>, label: string, milliseconds = 10_000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>(done => setTimeout(done, 30));
  }
  throw new Error(label);
}
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function directoryIdentity(path: string) { const stat = await lstat(path); return [stat.dev, stat.ino, stat.uid, stat.mode].join(":"); }
type BrowserResult = { status: number; headers: IncomingHttpHeaders; text: string; body: unknown };
function browserRequest(origin: string, path: string, token?: string, options: { method?: string; body?: unknown; key?: string } = {}): Promise<BrowserResult> {
  const url = new URL(origin), bytes = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return new Promise((done, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: Number(url.port), method: options.method ?? "GET", path, agent: false,
      headers: { Origin: origin, ...(token ? { "X-Chat-Token": token } : {}), ...(options.key ? { "Idempotency-Key": options.key } : {}),
        ...(bytes ? { "Content-Type": "application/json", "Content-Length": String(bytes.length) } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.once("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        done({ status: response.statusCode ?? 0, headers: response.headers, text, body }); });
    });
    outgoing.setTimeout(40_000, () => outgoing.destroy(new Error("fixture browser request timed out")));
    outgoing.once("error", reject); outgoing.end(bytes);
  });
}

describe("H5 → OWNER IPC → native environment restart → persisted chat recovery", () => {
  it("retains the original session and messages through safe service/database stop and start without dispatching a turn", async () => {
    const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : await realpath(tmpdir());
    const directory = await realpath(await mkdtemp(join(temporaryRoot, "as-recovery-"))); await chmod(directory, 0o700);
    const originalState = join(directory, "original"), stateDirectory = join(directory, "manager"), control = join(directory, "ctl");
    await mkdir(originalState, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 }); await mkdir(control, { mode: 0o700 });
    expect(Buffer.byteLength(join(control, "owner.sock"))).toBeLessThan(100);
    const data = join(originalState, "session.json"), oldRecord = join(originalState, "original-record.json"), script = join(directory, "child.mjs");
    const requests = join(directory, "requests.jsonl"), lifecycle = join(directory, "lifecycle.log"), checkpoints = join(stateDirectory, "durability.log");
    await writeFile(data, JSON.stringify(SEED), { mode: 0o600 }); await writeFile(oldRecord, '{"retained":"old-sealed-record"}\n', { mode: 0o600 });
    await writeFile(script, CHILD_SOURCE, { mode: 0o600 }); await writeFile(requests, "", { mode: 0o600 }); await writeFile(lifecycle, "", { mode: 0o600 });
    const retained = { data: await readFile(data), oldRecord: await readFile(oldRecord) }, node = await native.pinFile(await realpath(process.execPath));
    const children = new Map<number, Entry>(), releases = new Set<string>();
    const configs: Record<string, { witness: Witness; executable: Pin; cwd: string; args: string[]; env: Record<string, string>; port: number; uuid?: string; runId?: string }> = {};
    let app: Awaited<ReturnType<typeof chatModule.createChatH5Server>> | undefined;
    let owner: Awaited<ReturnType<typeof ownerModule.runEnvironmentOwner>> | undefined;
    let ipc: EnvironmentController | undefined;
    const originalUmask = process.umask();
    async function launch(name: string, runnerPort = 0) {
      const ready = join(directory, `${name}.ready`), release = join(directory, `${name}.release`); releases.add(release);
      const args = [script, name, "0", ready, lifecycle, data, release, String(runnerPort), requests];
      const env = { PATH: "/usr/bin:/bin", FIXTURE_SERVICE_KEY: SECRET, FIXTURE_USER: USER };
      const entry = await native.spawnOwned({ executable: node, args, cwd: directory, env, logPath: join(directory, `${name}.initial.log`) });
      children.set(entry.witness.pid, entry);
      await until(() => exists(ready), `${name} fixture did not become ready`);
      const observed = JSON.parse(await readFile(ready, "utf8")) as { pid: number; port: number };
      expect(observed.pid).toBe(entry.witness.pid); await native.assertListener(observed.port, observed.pid);
      return { entry, args: [script, name, String(observed.port), ready, lifecycle, data, release, String(runnerPort), requests], env, port: observed.port };
    }
    try {
      const prior = await launch("prior-owner"); await native.stopOwned(prior.entry);
      for (const name of NAMES) {
        const selected = await launch(name, name === "router" ? configs.runner!.port : 0);
        configs[name] = { witness: selected.entry.witness, executable: node, cwd: directory, args: selected.args, env: selected.env, port: selected.port,
          ...(name === "mysql" ? { uuid: "fixture-retained-mysql-uuid" } : {}), ...(name === "redis" ? { runId: INITIAL_RUN } : {}) };
      }
      const files = await Promise.all([script, data, oldRecord].map(async path => ({ path, sha256: (await native.pinFile(path)).sha256 })));
      const profilePath = join(directory, "profile.json"), controlClient = join(directory, "control-client.json"), runtimeClient = join(directory, "runtime-client.json");
      const profile = { schema: "local-environment-profile-v1", stateDirectory, originalState, controlDirectory: control, node, acceptedCommit: "2".repeat(40), files,
        directories: [{ path: originalState, identity: await directoryIdentity(originalState) }], abandonedControllers: [prior.entry.witness],
        roles: { router: configs.router, runner: configs.runner }, infrastructure: { mysql: configs.mysql, redis: configs.redis } };
      await native.writePrivateJson(profilePath, profile, { createOnly: true }); const retainedProfile = await readFile(profilePath);
      await native.writePrivateJson(runtimeClient, { BASE_URL: `http://127.0.0.1:${configs.router!.port}`, SERVICE_API_KEY: SECRET, USER_ID: USER,
        AGENT_ID: AGENT, AGENT_VERSION: "1", MODEL_CALL_ACK: "allow-model-calls-v1", REQUEST_TIMEOUT_MS: "1000", OPERATION_TIMEOUT_MS: "5000" }, { createOnly: true });
      owner = await ownerModule.runEnvironmentOwner({ profilePath, clientPath: controlClient, controlDirectory: control,
        driverFactory: options => driverModule.createLocalEnvironmentDriver(options),
        hooksFactory: async () => ({
          async beforeAction() {}, async checkIdle() { return true; },
          async ready(name, entry) {
            if (entry.child && entry.closed) children.set(entry.witness.pid, { child: entry.child, closed: entry.closed, witness: entry.witness });
            await until(async () => { try { await native.assertListener(entry.port, entry.witness.pid); return true; } catch { return false; } }, `${name} successor listener did not become ready`);
          },
          async beforeInfrastructureStop(name) { await appendFile(checkpoints, `${name}:durability-confirmed\n`, { mode: 0o600 }); },
          async afterInfrastructureStart(entries) { entries.redis!.runId = NEXT_RUN; return { redis: { runId: NEXT_RUN } }; },
        }),
      });
      ipc = await ownerModule.connectEnvironmentController(controlClient);
      app = await chatModule.createChatH5Server({ configPath: runtimeClient, port: 0, environmentController: ipc });
      const bootstrap = await browserRequest(app.url, "/api/config"); expect(bootstrap.status).toBe(200);
      const token = String((bootstrap.body as { csrfToken: string }).csrfToken); expect(token).toMatch(/^[a-f0-9]{64}$/);
      const read = (path: string) => browserRequest(app!.url, path, token);
      const beforeSession = await read(`/api/sessions/${SID}`), beforeItems = await read(`/api/sessions/${SID}/items?limit=200`), beforeTurns = await read(`/api/sessions/${SID}/turns?limit=20`);
      expect(beforeSession.status).toBe(200); expect(beforeSession.body).toEqual(SEED.session);
      expect(beforeItems.body).toEqual({ data: SEED.items }); expect(beforeTurns.body).toEqual({ data: [SEED.turn], nextCursor: null });
      async function environment() { const response = await read("/api/environment"); expect(response.status).toBe(200); return response.body as EnvironmentStatus; }
      async function lifecycleAction(selected: string) {
        const id = randomUUID();
        const response = await browserRequest(app!.url, "/api/environment/actions", token, { method: "POST", key: id, body: { action: selected } });
        expect(response.status).toBe(202); expect((response.body as { operation: unknown }).operation).toMatchObject({ id, action: selected });
        let observed: EnvironmentStatus | undefined;
        await until(async () => {
          observed = await environment();
          expect(observed.operation?.id).toBe(id);
          if (observed.operation?.state === "failed" || observed.operation?.state === "unknown") throw new Error(`fixture action did not succeed: ${selected}`);
          return observed.operation?.state === "succeeded";
        }, `exact operation did not complete: ${selected}`, 60_000);
        expect(observed?.operation).toMatchObject({ id, action: selected, state: "succeeded", error: null });
        return observed!;
      }
      expect((await environment()).overall).toBe("ready");
      const servicesDown = await lifecycleAction("stop-services");
      for (const id of ["router", "runner"]) expect(servicesDown.components.find(item => item.id === id)?.state).toBe("stopped");
      expect((await browserRequest(app.url, "/")).status).toBe(200);
      expect((await read("/api/config")).status).toBe(200);
      expect((await read("/api/health")).body).toEqual({ ready: false });
      expect((await lifecycleAction("stop-infrastructure")).overall).toBe("stopped");
      expect((await browserRequest(app.url, "/")).status).toBe(200);
      expect((await read("/api/config")).status).toBe(200);
      await lifecycleAction("start-infrastructure");
      expect((await lifecycleAction("start-services")).overall).toBe("ready");
      const restoredSession = await read(`/api/sessions/${SID}`), restoredItems = await read(`/api/sessions/${SID}/items?limit=200`), restoredTurns = await read(`/api/sessions/${SID}/turns?limit=20`);
      expect(restoredSession.status).toBe(200); expect(restoredSession.body).toEqual(beforeSession.body);
      expect(restoredItems.body).toEqual(beforeItems.body); expect(restoredTurns.body).toEqual(beforeTurns.body);
      expect(await readFile(data)).toEqual(retained.data); expect(await readFile(oldRecord)).toEqual(retained.oldRecord); expect(await readFile(profilePath)).toEqual(retainedProfile);
      expect((await readFile(checkpoints, "utf8")).trim().split("\n")).toEqual(["redis:durability-confirmed", "mysql:durability-confirmed"]);
      const forwarded = (await readFile(requests, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { role: string; method: string; path: string });
      expect(forwarded.filter(row => row.method === "POST")).toEqual([]);
      expect(forwarded.filter(row => row.method === "POST" && row.path.includes("/turns"))).toEqual([]);
      for (const role of ["router", "runner"]) expect(forwarded.filter(row => row.role === role && row.path.startsWith(`/v1/sessions/${SID}/items`))).toHaveLength(2);
      const ledger = JSON.parse(await readFile(join(stateDirectory, "processes.json"), "utf8")) as { entries: Record<string, { witness: Witness; runId: string }> };
      for (const name of NAMES) expect(ledger.entries[name]!.witness.pid).not.toBe(configs[name]!.witness.pid);
      expect(ledger.entries.redis!.runId).toBe(NEXT_RUN);
    } finally {
      await app?.close(); await ipc?.close(); await owner?.close();
      for (const release of releases) await writeFile(release, "fixture-exit", { mode: 0o600 });
      for (const entry of children.values()) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGTERM");
      await Promise.all([...children.values()].map(entry => entry.closed));
      process.umask(originalUmask); await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
