import { chmod, link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MysqlSessionStore, captureSessionAuthorityBindingCommand, type SessionAuthorityBindingCommandInput } from "@agent-service/store";
import { loadSessionAuthorityOperatorContext, parseSessionAuthorityOperatorConfiguration } from "../src/session-authority-operator-config.js";
import { runSessionAuthorityCli, type SessionAuthorityCliDependencies } from "../src/session-authority-cli.js";
import { readTelemetryCaptureRefKey } from "../src/telemetry-capture-ref-key.js";

// Parser/foreground ownership tests. Synthetic maintenance ports are not native MySQL proof.
const CANARY = "operator-native-error-must-not-escape";
const command = (): SessionAuthorityBindingCommandInput => ({
  bindingId: "11111111-1111-4111-8111-111111111111", activationId: "22222222-2222-4222-8222-222222222222",
  expectedBindingId: null, expectedSequence: 0, serverUuid: "33333333-3333-4333-8333-333333333333",
  applicationDatabase: "authority_operator_test", newAccounts: [{ user: "runtime_new", host: "localhost" }],
  oldAccountNames: [], activationEvidenceSha256: "a".repeat(64), nextEpoch: null,
  expectedSource: { kind: "inactive", runtimeControlGeneration: 0, runtimeControlEvidenceSha256: null,
    runtimeEpochSha256: null, restoreRunId: null, replayReceiptSha256: null },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "agent-service-authority-operator-test-"));
  await chmod(directory, 0o700);
  const path = join(directory, "command.json");
  await writeFile(path, JSON.stringify(command()), { flag: "wx", mode: 0o600 });
  const env: NodeJS.ProcessEnv = { AUTHORITY_MYSQL_URL: "mysql://operator:private-test-password@127.0.0.1/authority_operator_test",
    AUTHORITY_COMMAND_FILE: path, AUTHORITY_METADATA_SCHEMA: "authority_operator_test_metadata",
    AUTHORITY_METADATA_DEFINER_USER: "metadata_definer", AUTHORITY_METADATA_DEFINER_HOST: "localhost",
    AUTHORITY_FLEET_STOPPED_ACK: "all-application-writers-stopped-v1",
    AUTHORITY_EXCLUSIVE_CHANGE_ACK: "exclusive-authority-permissions-window-v1" };
  const output: string[] = [], errors: string[] = [], events: string[] = [];
  let interrupt = () => {};
  const store = {
    preflightSessionAuthorityBinding: vi.fn(async () => { events.push("preflight"); }),
    initializeSessionAuthorityBinding: vi.fn(async () => { events.push("activate"); }),
    confirmSessionAuthorityBinding: vi.fn(async () => { events.push("confirm"); }),
    close: vi.fn(async () => { events.push("close"); }),
  };
  const deps: SessionAuthorityCliDependencies = {
    connect: vi.fn(async (_url, _signal, context) => {
      const captured = captureSessionAuthorityBindingCommand(context.command);
      expect(captured.bindingId).toBe(command().bindingId);
      expect(captured.nextEpoch).toBeNull(); events.push("connect"); return store;
    }),
    writeLine: line => { events.push("output"); output.push(line); },
    writeError: line => { errors.push(line); },
    installInterrupts: vi.fn(stop => { interrupt = stop; return () => { events.push("remove"); }; }),
  };
  return { directory, path, env, output, errors, events, store, deps,
    interrupt: () => interrupt(), close: () => rm(directory, { recursive: true, force: true }) };
}

describe("fixed session authority operator command", () => {
  it("keeps help resource-free without inspecting authority environment", async () => {
    const connect = vi.fn(), installInterrupts = vi.fn(), output: string[] = [];
    const deps = { connect, installInterrupts, writeLine: (line: string) => { output.push(line); }, writeError: vi.fn() };
    const env = new Proxy({}, { ownKeys() { throw Error(CANARY); }, get() { throw Error(CANARY); } });
    expect(await runSessionAuthorityCli(["authority", "--help"], env, deps)).toBe(0);
    expect(output).toHaveLength(1); expect(output[0]).toContain("authority <preflight|activate>");
    expect(connect).not.toHaveBeenCalled(); expect(installInterrupts).not.toHaveBeenCalled();
  });

  it.each(["preflight", "activate"] as const)("%s waits for actual port closure before publishing success", async mode => {
    const f = await fixture(), closing = deferred(), entered = deferred();
    f.store.close.mockImplementationOnce(async () => { f.events.push("close-enter"); entered.resolve(); await closing.promise; f.events.push("close-settled"); });
    try {
      const running = runSessionAuthorityCli(["authority", mode], f.env, f.deps);
      await entered.promise; expect(f.output).toEqual([]); expect(f.events).not.toContain("remove");
      expect(f.events).toEqual(mode === "activate" ? ["connect", "activate", "confirm", "close-enter"] : ["connect", "preflight", "close-enter"]);
      closing.resolve(); expect(await running).toBe(0); expect(f.errors).toEqual([]);
      expect(f.events.slice(-3)).toEqual(["close-settled", "remove", "output"]);
      expect(JSON.parse(f.output[0]!)).toEqual({ status: "ok", command: mode, activated: mode === "activate", commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(f.output.join()).not.toContain("private-test-password");
    } finally { closing.resolve(); await f.close(); }
  });

  it("keeps a rejection with undefined from close as failure", async () => {
    const f = await fixture();
    f.store.close.mockRejectedValueOnce(undefined);
    try {
      expect(await runSessionAuthorityCli(["authority", "activate"], f.env, f.deps)).toBe(1);
      expect(f.store.confirmSessionAuthorityBinding).toHaveBeenCalledOnce();
      expect(f.output).toEqual([]); expect(f.errors).toEqual(['{"status":"error","code":"operation_failed"}']);
    } finally { await f.close(); }
  });

  it("preserves an undefined operation rejection when cleanup also rejects", async () => {
    const f = await fixture();
    f.store.initializeSessionAuthorityBinding.mockRejectedValueOnce(undefined);
    f.store.close.mockRejectedValueOnce(Error("invalid_configuration"));
    try {
      expect(await runSessionAuthorityCli(["authority", "activate"], f.env, f.deps)).toBe(1);
      expect(f.store.confirmSessionAuthorityBinding).not.toHaveBeenCalled();
      expect(f.output).toEqual([]); expect(f.errors).toEqual(['{"status":"error","code":"operation_failed"}']);
    } finally { await f.close(); }
  });

  it("does not return on interruption until admitted raw work and close settle", async () => {
    const f = await fixture(), entered = deferred(), work = deferred(), closing = deferred(), closeEntered = deferred();
    f.store.initializeSessionAuthorityBinding.mockImplementationOnce(async () => { entered.resolve(); await work.promise; });
    f.store.close.mockImplementationOnce(async () => { closeEntered.resolve(); await closing.promise; });
    let settled = false;
    try {
      const running = runSessionAuthorityCli(["authority", "activate"], f.env, f.deps);
      void running.then(() => { settled = true; });
      await entered.promise; f.interrupt(); await Promise.resolve(); expect(settled).toBe(false); expect(f.output).toEqual([]);
      work.resolve(); await closeEntered.promise; expect(settled).toBe(false);
      closing.resolve(); expect(await running).toBe(1);
      expect(f.output).toEqual([]); expect(f.errors).toEqual(['{"status":"error","code":"operation_cancelled"}']);
    } finally { work.resolve(); closing.resolve(); await f.close(); }
  });

  it("keeps the captured command immutable when its private file changes later", async () => {
    const f = await fixture();
    try {
      const config = parseSessionAuthorityOperatorConfiguration(f.env);
      const context = await loadSessionAuthorityOperatorContext(config);
      const first = captureSessionAuthorityBindingCommand(context.command);
      await writeFile(f.path, JSON.stringify({ ...command(), bindingId: "44444444-4444-4444-8444-444444444444" }));
      expect(captureSessionAuthorityBindingCommand(context.command)).toBe(first);
      expect(first.bindingId).toBe(command().bindingId); expect(Object.isFrozen(first)).toBe(true);
    } finally { await f.close(); }
  });

  it("rejects unknown authority accessors without evaluating them", async () => {
    const f = await fixture(); let reads = 0;
    try {
      Object.defineProperty(f.env, "AUTHORITY_FUTURE", { enumerable: false, get() { reads++; throw Error(CANARY); } });
      expect(() => parseSessionAuthorityOperatorConfiguration(f.env)).toThrow("invalid_configuration"); expect(reads).toBe(0);
      expect(await runSessionAuthorityCli(["authority", "activate"], f.env, f.deps)).toBe(1);
      expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.deps.installInterrupts).not.toHaveBeenCalled();
      expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
    } finally { await f.close(); }
  });

  it.each(["url", "stopped", "exclusive", "metadata", "timeout"] as const)("refuses invalid %s authority before resource work", async kind => {
    const f = await fixture();
    try {
      if (kind === "url") { delete f.env.AUTHORITY_MYSQL_URL; f.env.MYSQL_URL = "mysql://wrong:private@127.0.0.1/other"; }
      if (kind === "stopped") f.env.AUTHORITY_FLEET_STOPPED_ACK = "1";
      if (kind === "exclusive") f.env.AUTHORITY_EXCLUSIVE_CHANGE_ACK = "";
      if (kind === "metadata") delete f.env.AUTHORITY_METADATA_DEFINER_HOST;
      if (kind === "timeout") f.env.AUTHORITY_OPERATION_TIMEOUT_MS = "120001";
      expect(await runSessionAuthorityCli(["authority", "activate"], f.env, f.deps)).toBe(1);
      expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.deps.installInterrupts).not.toHaveBeenCalled();
      expect(f.output).toEqual([]); expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
    } finally { await f.close(); }
  });

  it.each(["file-mode", "directory-mode", "symlink", "hardlink", "duplicate", "escaped-duplicate", "oversize", "invalid-utf8"] as const)
    ("refuses a %s fixed command without opening MySQL", async kind => {
      const f = await fixture();
      try {
        if (kind === "file-mode") await chmod(f.path, 0o644);
        if (kind === "directory-mode") await chmod(f.directory, 0o755);
        if (kind === "symlink") { const target = join(f.directory, "target.json"); await writeFile(target, await readFile(f.path), { mode: 0o600 }); await rm(f.path); await symlink(target, f.path); }
        if (kind === "hardlink") await link(f.path, join(f.directory, "second.json"));
        if (kind === "duplicate") await writeFile(f.path, JSON.stringify(command()).replace('{', '{"expectedSequence":0,'));
        if (kind === "escaped-duplicate") await writeFile(f.path, JSON.stringify(command()).replace('{', '{"expected\\u0053equence":0,'));
        if (kind === "oversize") await writeFile(f.path, " ".repeat(65_537));
        if (kind === "invalid-utf8") await writeFile(f.path, Buffer.from([0x7b, 0xff, 0x7d]));
        expect(await runSessionAuthorityCli(["authority", "activate"], f.env, f.deps)).toBe(1);
        expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.output).toEqual([]);
        expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
      } finally { await f.close(); }
    });
});


async function protectedRefKey(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const path = join(f.directory, "ref-key.bin"), bytes = Buffer.alloc(32, 0x42);
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  finally { bytes.fill(0); }
  f.env.TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE = path;
  return path;
}

describe("authority protected telemetry ref-key wiring", () => {
  // These remain pure foreground/FS ownership tests. The actual default Store factory is
  // intercepted only to inspect forwarding and reject; it never supplies fake MySQL success.
  it("forwards the protected key to the actual default maintenance factory without exposing it", async () => {
    const f = await fixture(), path = await protectedRefKey(f), output: string[] = [], errors: string[] = [];
    let key: Uint8Array | undefined;
    const connect = vi.spyOn(MysqlSessionStore, "connectRestoreJournalMaintenance").mockImplementation(async (options, profile) => {
      expect(options.url).toBe(f.env.AUTHORITY_MYSQL_URL);
      expect(options.connectionLimit).toBe(1); expect(options.operationAbortSignal).toBeInstanceOf(AbortSignal);
      expect(profile.kind).toBe("operator-maintenance");
      key = options.tenantTelemetryRefKey; expect(key).toEqual(Buffer.alloc(32, 0x42));
      throw Error(CANARY);
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { errors.push(String(chunk)); return true; });
    try {
      expect(await runSessionAuthorityCli(["authority", "preflight"], f.env)).toBe(1);
      expect(connect).toHaveBeenCalledOnce(); expect(key?.every(value => value === 0)).toBe(true);
      expect(output).toEqual([]); expect(errors).toEqual(['{"status":"error","code":"operation_failed"}\n']);
      expect(errors.join()).not.toContain(CANARY); expect(errors.join()).not.toContain(path);
      expect(errors.join()).not.toContain(Buffer.alloc(32, 0x42).toString("hex"));
    } finally { stderr.mockRestore(); stdout.mockRestore(); connect.mockRestore(); await f.close(); }
  });

  it.for(["preflight", "activate"] as const)("%s keeps the exact key alive until the original close settles and then wipes it", async (mode, { signal }) => {
    const f = await fixture(), path = await protectedRefKey(f), closing = deferred(), entered = deferred();
    let key: Buffer | undefined, running: Promise<0 | 1> | undefined, settled = false;
    f.deps.readRefKey = vi.fn(async actualPath => { expect(actualPath).toBe(path); key = await readTelemetryCaptureRefKey(actualPath); return key; });
    f.store.close.mockImplementationOnce(async () => { f.events.push("close-enter"); entered.resolve(); await closing.promise; f.events.push("close-settled"); });
    const abort = () => { f.interrupt(); closing.resolve(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      running = runSessionAuthorityCli(["authority", mode], f.env, f.deps);
      void running.then(() => { settled = true; entered.resolve(); }, () => { settled = true; entered.resolve(); });
      await entered.promise;
      expect(f.store.close).toHaveBeenCalledOnce(); expect(settled).toBe(false); expect(f.output).toEqual([]);
      expect(key).toEqual(Buffer.alloc(32, 0x42));
      expect(f.deps.connect).toHaveBeenCalledWith(f.env.AUTHORITY_MYSQL_URL, expect.any(AbortSignal), expect.any(Object), key);
      closing.resolve(); expect(await running).toBe(0); expect(key?.every(value => value === 0)).toBe(true);
      expect(f.errors).toEqual([]); expect(f.events.slice(-3)).toEqual(["close-settled", "remove", "output"]);
      expect(f.store.initializeSessionAuthorityBinding).toHaveBeenCalledTimes(mode === "activate" ? 1 : 0);
      expect(f.store.confirmSessionAuthorityBinding).toHaveBeenCalledTimes(mode === "activate" ? 1 : 0);
    } finally {
      signal.removeEventListener("abort", abort); if (!settled) f.interrupt(); closing.resolve();
      if (running) await Promise.allSettled([running]); await f.close();
    }
  });

  it.each(["missing", "short", "symlink", "hardlink", "mode", "application-hex", "empty-application-hex"] as const)
    ("refuses a %s operator key before maintenance connection", async kind => {
      const f = await fixture(), path = await protectedRefKey(f);
      f.deps.readRefKey = vi.fn(readTelemetryCaptureRefKey);
      try {
        if (kind === "missing") await rm(path);
        if (kind === "short") await writeFile(path, Buffer.alloc(31, 0x42));
        if (kind === "symlink") {
          const target = join(f.directory, "key-target.bin"); await writeFile(target, Buffer.alloc(32, 0x42), { mode: 0o600 });
          await rm(path); await symlink(target, path);
        }
        if (kind === "hardlink") await link(path, join(f.directory, "key-hardlink.bin"));
        if (kind === "mode") await chmod(path, 0o644);
        if (kind === "application-hex" || kind === "empty-application-hex") {
          f.env.TENANT_TELEMETRY_REF_KEY = kind === "application-hex" ? "42".repeat(32) : "";
        }
        expect(await runSessionAuthorityCli(["authority", "activate"], f.env, f.deps)).toBe(1);
        expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.output).toEqual([]);
        expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
        if (kind === "application-hex" || kind === "empty-application-hex") {
          expect(f.deps.readRefKey).not.toHaveBeenCalled(); expect(f.deps.installInterrupts).not.toHaveBeenCalled();
        }
        expect(f.errors.join()).not.toContain(path); expect(f.errors.join()).not.toContain("42".repeat(32));
      } finally { await f.close(); }
    });

  it("awaits a protected-key read that fulfills after interruption and wipes its late buffer", async ({ signal }) => {
    const f = await fixture(); await protectedRefKey(f);
    const entered = deferred(), release = deferred(), key = Buffer.alloc(32, 0x42);
    let running: Promise<0 | 1> | undefined, settled = false;
    f.deps.readRefKey = vi.fn(async () => { entered.resolve(); await release.promise; return key; });
    const abort = () => { f.interrupt(); release.resolve(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      running = runSessionAuthorityCli(["authority", "activate"], f.env, f.deps);
      void running.then(() => { settled = true; entered.resolve(); }, () => { settled = true; entered.resolve(); });
      await entered.promise; expect(f.deps.readRefKey).toHaveBeenCalledOnce();
      f.interrupt(); await Promise.resolve(); expect(settled).toBe(false); expect(f.output).toEqual([]);
      release.resolve(); expect(await running).toBe(1);
      expect(f.deps.connect).not.toHaveBeenCalled(); expect(key.every(value => value === 0)).toBe(true);
      expect(f.errors).toEqual(['{"status":"error","code":"operation_cancelled"}']);
    } finally {
      signal.removeEventListener("abort", abort); if (!settled) f.interrupt(); release.resolve();
      if (running) await Promise.allSettled([running]); key.fill(0); await f.close();
    }
  });

  it("keeps the configured authority deadline around the original pending key read", async ({ signal }) => {
    const f = await fixture(); await protectedRefKey(f); f.env.AUTHORITY_OPERATION_TIMEOUT_MS = "1000";
    const entered = deferred(), release = deferred(), key = Buffer.alloc(32, 0x42);
    let running: Promise<0 | 1> | undefined, settled = false;
    f.deps.readRefKey = vi.fn(async () => { entered.resolve(); await release.promise; return key; });
    const abort = () => { f.interrupt(); release.resolve(); };
    signal.addEventListener("abort", abort, { once: true }); vi.useFakeTimers();
    try {
      running = runSessionAuthorityCli(["authority", "activate"], f.env, f.deps);
      void running.then(() => { settled = true; entered.resolve(); }, () => { settled = true; entered.resolve(); });
      await entered.promise; expect(f.deps.readRefKey).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000); expect(settled).toBe(false); expect(f.output).toEqual([]);
      release.resolve(); expect(await running).toBe(1);
      expect(f.deps.connect).not.toHaveBeenCalled(); expect(key.every(value => value === 0)).toBe(true);
      expect(f.errors).toEqual(['{"status":"error","code":"operation_deadline"}']);
    } finally {
      signal.removeEventListener("abort", abort); if (!settled) f.interrupt(); release.resolve();
      if (running) await Promise.allSettled([running]); vi.useRealTimers(); key.fill(0); await f.close();
    }
  });

  it("joins a maintenance connection returned after cancellation before wiping its key", async ({ signal }) => {
    const f = await fixture(); await protectedRefKey(f);
    const entered = deferred(), release = deferred(), closeEntered = deferred(), closeRelease = deferred();
    let key: Uint8Array | undefined, running: Promise<0 | 1> | undefined, settled = false;
    f.deps.connect = vi.fn(async (_url, _signal, _context, capturedKey) => {
      key = capturedKey; entered.resolve(); await release.promise; return f.store;
    });
    f.store.close.mockImplementationOnce(async () => { closeEntered.resolve(); await closeRelease.promise; });
    const abort = () => { f.interrupt(); release.resolve(); closeRelease.resolve(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      running = runSessionAuthorityCli(["authority", "activate"], f.env, f.deps);
      void running.then(() => { settled = true; entered.resolve(); closeEntered.resolve(); }, () => { settled = true; entered.resolve(); closeEntered.resolve(); });
      await entered.promise; expect(f.deps.connect).toHaveBeenCalledOnce(); f.interrupt(); await Promise.resolve();
      expect(settled).toBe(false); release.resolve(); await closeEntered.promise;
      expect(f.store.close).toHaveBeenCalledOnce(); expect(settled).toBe(false); expect(key).toEqual(Buffer.alloc(32, 0x42));
      expect(f.store.initializeSessionAuthorityBinding).not.toHaveBeenCalled(); expect(f.store.confirmSessionAuthorityBinding).not.toHaveBeenCalled();
      closeRelease.resolve(); expect(await running).toBe(1); expect(key?.every(value => value === 0)).toBe(true);
      expect(f.output).toEqual([]); expect(f.errors).toEqual(['{"status":"error","code":"operation_cancelled"}']);
    } finally {
      signal.removeEventListener("abort", abort); if (!settled) f.interrupt(); release.resolve(); closeRelease.resolve();
      if (running) await Promise.allSettled([running]); await f.close();
    }
  });

  it("keeps an undefined operation first when keyed close also fails and still wipes the key", async () => {
    const f = await fixture(); await protectedRefKey(f); let key: Buffer | undefined;
    f.deps.readRefKey = async path => { key = await readTelemetryCaptureRefKey(path); return key; };
    f.store.initializeSessionAuthorityBinding.mockRejectedValueOnce(undefined);
    f.store.close.mockRejectedValueOnce(Error("invalid_configuration"));
    try {
      expect(await runSessionAuthorityCli(["authority", "activate"], f.env, f.deps)).toBe(1);
      expect(f.store.close).toHaveBeenCalledOnce(); expect(f.store.confirmSessionAuthorityBinding).not.toHaveBeenCalled();
      expect(key?.every(value => value === 0)).toBe(true); expect(f.output).toEqual([]);
      expect(f.errors).toEqual(['{"status":"error","code":"operation_failed"}']);
    } finally { await f.close(); }
  });

  it("refuses a malformed reader buffer and wipes it before any maintenance connection", async () => {
    const f = await fixture(); await protectedRefKey(f); const key = Buffer.alloc(31, 0x42);
    f.deps.readRefKey = async () => key;
    try {
      expect(await runSessionAuthorityCli(["authority", "activate"], f.env, f.deps)).toBe(1);
      expect(f.deps.connect).not.toHaveBeenCalled(); expect(key.every(value => value === 0)).toBe(true);
      expect(f.output).toEqual([]); expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
    } finally { key.fill(0); await f.close(); }
  });
});
