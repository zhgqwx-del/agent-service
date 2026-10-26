import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Json = Record<string, unknown>;
type Pin = { path: string; dev: number; ino: number; size: number; sha256: string };
type Component = { id: string; state: string; pid?: number };
type Status = { overall: string; components: Component[]; operation: Json | null; actions: { id: string; enabled: boolean }[] };
type Client = { status(): Promise<Status>; act(input: { action: string; idempotencyKey: string }): Promise<{ operation: Json }>; close(): Promise<void> };
type FakeDriver = ReturnType<typeof fakeDriver>;
type Owner = { close(): Promise<void>; driver: FakeDriver };
type OwnerOptions = {
  profilePath: string; clientPath: string; controlDirectory?: string;
  driverFactory(args: { profilePath: string }): Promise<FakeDriver>;
  hooksFactory(profile: Json): Promise<Json>;
};
let ownerModule: {
  runEnvironmentOwner(options: OwnerOptions): Promise<Owner>;
  connectEnvironmentController(configPath: string): Promise<Client>;
};
let nodePin: Pin;

beforeAll(async () => {
  ownerModule = await import(new URL("../scripts/ops/local-environment-owner.mjs", import.meta.url).href) as typeof ownerModule;
  const native = await import(new URL("../scripts/ops/local-environment-native.mjs", import.meta.url).href) as { pinFile(path: string): Promise<Pin> };
  nodePin = await native.pinFile(await realpath(process.execPath));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fakeDriver() {
  const entered = deferred(), gate = deferred();
  let hold = false;
  const calls: { action: string; operation: Json | undefined }[] = [];
  const driver = {
    calls, entered: entered.promise, release: gate.resolve, hold() { hold = true; },
    snapshot: vi.fn(async () => ({ overall: "ready", components: ["owner", "router", "runner", "mysql", "redis"]
      .map((id, index) => ({ id, state: "ready", pid: process.pid + index })) })),
    checkIdle: vi.fn(async () => true),
    setHooks: vi.fn((_hooks: Json) => {}),
    detach: vi.fn(() => {}),
    perform: vi.fn(async (action: string, options: { phase?: (phase: string) => Promise<void>; operation?: Json } = {}) => {
      calls.push({ action, operation: options.operation }); entered.resolve();
      await options.phase?.("fixture-running");
      if (hold) await gate.promise;
    }),
  };
  return driver;
}

async function fixture(start = true) {
  // macOS UDS paths have a short native limit; do not use its long TMPDIR prefix.
  const base = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const dir = await realpath(await mkdtemp(join(base, "as-owner-")));
  await chmod(dir, 0o700);
  const stateDirectory = join(dir, "state"), controlDirectory = join(dir, "control");
  await mkdir(stateDirectory, { mode: 0o700 }); await mkdir(controlDirectory, { mode: 0o700 });
  const profilePath = join(dir, "profile.json"), clientPath = join(dir, "client.json"), markerPath = join(stateDirectory, "data-marker.txt");
  const profile = { schema: "local-environment-profile-v1", node: nodePin, controlDirectory, stateDirectory };
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  await writeFile(markerPath, "existing conversation bytes\n", { mode: 0o600 });
  const driver = fakeDriver(), driverFactory = vi.fn(async (_args: { profilePath: string }) => driver);
  const hooksFactory = vi.fn(async (_profile: Json) => ({}));
  const previousUmask = process.umask();
  let owner: Owner | undefined, client: Client | undefined;
  const f = {
    dir, profilePath, clientPath, stateDirectory, controlDirectory, markerPath, profile, driver, driverFactory, hooksFactory,
    get owner() { if (!owner) throw new Error("fixture owner missing"); return owner; },
    get client() { if (!client) throw new Error("fixture client missing"); return client; },
    async start(controlOverride?: string) {
      owner = await ownerModule.runEnvironmentOwner({ profilePath, clientPath, driverFactory, hooksFactory,
        ...(controlOverride ? { controlDirectory: controlOverride } : {}) });
      client = await ownerModule.connectEnvironmentController(clientPath);
      return owner;
    },
    async config() { return JSON.parse(await readFile(clientPath, "utf8")) as { token: string; socketPath: string; owner: Json }; },
    async close() {
      driver.release();
      try { await client?.close(); await owner?.close(); }
      finally { process.umask(previousUmask); await rm(dir, { recursive: true, force: true }); }
    },
  };
  if (start) {
    try { await f.start(); } catch (error) { await f.close(); throw error; }
  }
  return f;
}

async function rawRequest(socketPath: string, value: unknown): Promise<Json> {
  return await new Promise<Json>((done, reject) => {
    const socket = createConnection(socketPath);
    let bytes = "", result: Json | undefined, failure: Error | undefined;
    socket.setTimeout(3000, () => { failure = new Error("fixture IPC timeout"); socket.destroy(); });
    socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", chunk => {
      bytes += chunk.toString("utf8");
      if (!bytes.includes("\n")) return;
      try { result = JSON.parse(bytes.trim()) as Json; } catch { failure = new Error("fixture IPC response invalid"); }
      socket.destroy();
    });
    socket.once("error", error => { failure = error; socket.destroy(); });
    socket.once("end", () => { if (result === undefined) failure ??= new Error("fixture IPC ended without reply"); });
    socket.once("close", () => failure ? reject(failure) : result ? done(result) : reject(new Error("fixture IPC closed without reply")));
  });
}
async function completed(client: Client, id: string): Promise<Status> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const status = await client.status();
    if (status.operation?.id === id && status.operation.state !== "running") return status;
    await pause(10);
  }
  throw new Error("fixture operation did not settle");
}

describe("local environment OWNER IPC", () => {
  it("publishes a private client and returns all five components through the real socket", async () => {
    const f = await fixture();
    try {
      const status = await f.client.status();
      expect(status.overall).toBe("ready");
      expect(status.components.map(row => row.id)).toEqual(["owner", "router", "runner", "mysql", "redis"]);
      expect(status.components.every(row => row.state === "ready")).toBe(true);
      expect(f.driverFactory).toHaveBeenCalledExactlyOnceWith({ profilePath: f.profilePath });
      expect(f.hooksFactory).toHaveBeenCalledExactlyOnceWith(f.profile);
      expect(f.driver.setHooks).toHaveBeenCalledExactlyOnceWith({});
      const config = await f.config();
      expect(config.socketPath).toBe(join(f.controlDirectory, "owner.sock"));
      expect(config.token).toMatch(/^[a-f0-9]{64}$/);
      expect((await lstat(f.clientPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(config.socketPath)).mode & 0o777).toBe(0o600);
      await f.client.close();
      expect((await f.client.status()).overall).toBe("ready");
      expect(f.driver.calls).toEqual([]);
    } finally { await f.close(); }
  });

  it("maps UUID idempotency over IPC to one execution and preserves the selected action", async () => {
    const f = await fixture();
    const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", canonical = id.toLowerCase();
    f.driver.hold();
    try {
      const accepted = await f.client.act({ action: "restart-services", idempotencyKey: id });
      await f.driver.entered;
      expect(accepted.operation).toMatchObject({ id: canonical, action: "restart-services", state: "running" });
      const replay = await f.client.act({ action: "restart-services", idempotencyKey: canonical });
      expect(replay.operation).toMatchObject({ id: canonical, action: "restart-services", state: "running" });
      await expect(f.client.act({ action: "stop-infrastructure", idempotencyKey: canonical }))
        .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
      expect(f.driver.calls.map(call => call.action)).toEqual(["restart-services"]);
      expect(f.driver.calls[0]?.operation).toMatchObject({ id: canonical, action: "restart-services" });
      f.driver.release();
      const status = await completed(f.client, canonical);
      expect(status.operation).toMatchObject({ id: canonical, action: "restart-services", state: "succeeded", phase: "completed" });
      expect((await f.client.act({ action: "restart-services", idempotencyKey: id })).operation.state).toBe("succeeded");
      expect(f.driver.perform).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("rejects wrong tokens and unsupported socket methods without dispatching or retrying", async () => {
    const f = await fixture();
    try {
      const config = await f.config();
      const wrongToken = (config.token[0] === "0" ? "1" : "0") + config.token.slice(1);
      expect(await rawRequest(config.socketPath, { token: wrongToken, method: "act", input: {
        action: "stop-services", idempotencyKey: "00000000-0000-4000-8000-000000000001",
      } })).toEqual({ error: "environment_unavailable", status: 503 });
      expect(await rawRequest(config.socketPath, { token: config.token, method: "run-shell" }))
        .toEqual({ error: "invalid_action", status: 400 });
      expect(await rawRequest(config.socketPath, { token: config.token, method: "status", input: {} }))
        .toEqual({ error: "invalid_action", status: 400 });
      expect(await rawRequest(config.socketPath, { token: config.token, method: "act", input: {
        action: "erase-data", idempotencyKey: "00000000-0000-4000-8000-000000000002",
      } })).toEqual({ error: "invalid_action", status: 400 });
      expect(f.driver.perform).not.toHaveBeenCalled();
      expect((await f.client.status()).operation).toBeNull();
    } finally { await f.close(); }
  });

  it("closing OWNER removes only its socket and lock, retaining data and private evidence", async () => {
    const f = await fixture();
    try {
      const configBytes = await readFile(f.clientPath), profileBytes = await readFile(f.profilePath);
      const config = await f.config();
      await f.owner.close();
      expect(f.driver.perform).not.toHaveBeenCalled();
      expect(f.driver.detach).toHaveBeenCalledTimes(1);
      expect(await readFile(f.markerPath, "utf8")).toBe("existing conversation bytes\n");
      expect(await readFile(f.clientPath)).toEqual(configBytes);
      expect(await readFile(f.profilePath)).toEqual(profileBytes);
      expect(JSON.parse(await readFile(join(f.stateDirectory, "owner-" + process.pid + ".json"), "utf8")))
        .toMatchObject({ schema: "local-environment-owner-v1", originalRecordsRetained: true, modelCalls: 0 });
      await expect(lstat(config.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(f.controlDirectory, "owner.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(f.client.status()).rejects.toMatchObject({ code: "environment_unavailable", status: 503 });
      expect(f.driver.perform).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("rejects a public control-directory override before constructing a driver or lock", async () => {
    const f = await fixture(false);
    try {
      const publicControl = join(f.dir, "public-control");
      await mkdir(publicControl, { mode: 0o755 }); await chmod(publicControl, 0o755);
      await expect(f.start(publicControl)).rejects.toMatchObject({ code: "environment_unavailable", status: 503 });
      expect(f.driverFactory).not.toHaveBeenCalled();
      await expect(lstat(join(publicControl, "owner.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(f.markerPath, "utf8")).toBe("existing conversation bytes\n");
    } finally { await f.close(); }
  });

  it("retains an existing OWNER lock and refuses to construct another management chain", async () => {
    const f = await fixture(false);
    try {
      const lockPath = join(f.controlDirectory, "owner.lock"), retained = "retained independent OWNER evidence\n";
      await writeFile(lockPath, retained, { mode: 0o600 });
      await expect(f.start()).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(lockPath, "utf8")).toBe(retained);
      expect(f.driverFactory).not.toHaveBeenCalled();
      expect(f.driver.perform).not.toHaveBeenCalled();
      await expect(lstat(f.clientPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.close(); }
  });
});
