import { describe, expect, it, vi } from "vitest";
import {
  prepareSessionAuthorityBindingCommand,
  type SessionAuthorityBindingOperatorContext,
} from "@agent-service/store";
import {
  formatRestoreLedgerReconcileCliError,
  runRestoreLedgerReconcileCli,
  type RestoreLedgerReconcileCliDependencies,
} from "../src/restore-ledger-reconcile-cli.js";
import type { TenantRestoreJournalRuntimeConfig } from "../src/tenant-restore-journal-config.js";

// Synthetic negative/lifetime ports only: no successful SQL, activation, receipt or native-close proof.
type Dependencies = RestoreLedgerReconcileCliDependencies;
type Store = Awaited<ReturnType<Dependencies["connectStore"]>>;
type Adapter = ReturnType<Dependencies["createAdapters"]>[number];
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixedContext(): SessionAuthorityBindingOperatorContext {
  return Object.freeze({
    command: prepareSessionAuthorityBindingCommand({
      bindingId: "11111111-1111-4111-8111-111111111111", activationId: "22222222-2222-4222-8222-222222222222",
      expectedBindingId: null, expectedSequence: 0, serverUuid: "33333333-3333-4333-8333-333333333333",
      applicationDatabase: "authority_budget_test", newAccounts: [{ user: "runtime_new", host: "localhost" }],
      oldAccountNames: [], activationEvidenceSha256: "a".repeat(64), nextEpoch: null,
      expectedSource: { kind: "inactive", runtimeControlGeneration: 0, runtimeControlEvidenceSha256: null,
        runtimeEpochSha256: null, restoreRunId: null, replayReceiptSha256: null },
    }),
    schemaMetadata: { metadataSchema: "authority_budget_metadata", trustedDefiner: { user: "metadata_definer", host: "localhost" } },
    assertNativeAdmission: async () => { throw Error("synthetic ports must not perform native admission"); },
  });
}
function environment(timeout?: string): NodeJS.ProcessEnv {
  return {
    AUTHORITY_MYSQL_URL: "mysql://operator@127.0.0.1/authority_budget_test",
    AUTHORITY_COMMAND_FILE: "/private/authority-budget-test/command.json",
    AUTHORITY_METADATA_SCHEMA: "authority_budget_metadata",
    AUTHORITY_METADATA_DEFINER_USER: "metadata_definer", AUTHORITY_METADATA_DEFINER_HOST: "localhost",
    AUTHORITY_FLEET_STOPPED_ACK: "all-application-writers-stopped-v1",
    AUTHORITY_EXCLUSIVE_CHANGE_ACK: "exclusive-authority-permissions-window-v1",
    ...(timeout === undefined ? {} : { AUTHORITY_OPERATION_TIMEOUT_MS: timeout }),
    RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK: "1", RESTORE_FLEET_STOPPED_ACK: "1",
    RESTORE_JOURNAL_S3_BUCKET: "restore-budget-fixture", BLOB_STORE: "filesystem",
  };
}
function harness() {
  const output: string[] = [], nativeError = Error("synthetic read must reject before any business mutation");
  const read = vi.fn(async function (this: unknown): Promise<never> {
    expect(this).toBe(store); throw nativeError;
  });
  const storeClose = vi.fn(async () => {}), adapterClose = vi.fn(async () => {});
  const startup = vi.fn(async () => {});
  // Real facades are frozen. The local boundary view must not violate Proxy get invariants.
  const store = Object.freeze({ getTenantRestoreJournalControl: read, getTenantRestoreReplayRun: read,
    close: storeClose }) as unknown as Store;
  const adapter = Object.freeze({ validateStartup: startup, close: adapterClose }) as unknown as Adapter;
  const connectStore = vi.fn(async (_options: Parameters<Dependencies["connectStore"]>[0]) => store);
  const createAdapters = vi.fn((_config: TenantRestoreJournalRuntimeConfig,
    _operation?: { operationAbortSignal?: AbortSignal }) => [adapter]);
  const loadAuthorityContext = vi.fn(async (_configuration: Parameters<NonNullable<Dependencies["loadAuthorityContext"]>>[0],
    _signal?: AbortSignal) => fixedContext());
  const dependencies: Dependencies = {
    connectStore, createAdapters, loadAuthorityContext,
    loadJournalConfig: () => ({ targets: [] } as unknown as TenantRestoreJournalRuntimeConfig),
    writeLine: line => { output.push(line); },
  };
  return { dependencies, connectStore, createAdapters, loadAuthorityContext, read, nativeError, store,
    storeClose, adapterClose, startup, output };
}
function observe(task: Promise<number>) {
  let settled = false;
  const result = task.then(value => { settled = true; return { ok: true as const, value }; },
    error => { settled = true; return { ok: false as const, error }; });
  return { result, settled: () => settled };
}

async function waitForEntry(entry: Promise<void>, result: Promise<unknown>, signal: AbortSignal): Promise<void> {
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(Error("test cancelled before owned entry")); };
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([entry, result.then(() => { throw Error("operation settled before expected owned entry"); }), aborted]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

describe("restore authority activation budget ownership", () => {
  it("consumes the default 120000ms before fixed context loading and joins that original load", async test => {
    vi.useFakeTimers();
    const f = harness(), entered = deferred<void>(), loading = deferred<SessionAuthorityBindingOperatorContext>();
    let signal: AbortSignal | undefined;
    f.loadAuthorityContext.mockImplementationOnce(async (_config, current) => {
      signal = current; entered.resolve(undefined); return loading.promise;
    });
    const cancel = () => { loading.resolve(fixedContext()); };
    test.signal.addEventListener("abort", cancel, { once: true });
    const running = observe(runRestoreLedgerReconcileCli(["activate-journal"], environment(), f.dependencies));
    try {
      await waitForEntry(entered.promise, running.result, test.signal);
      await vi.advanceTimersByTimeAsync(119_999); expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(signal?.aborted).toBe(true);
      expect(running.settled()).toBe(false); expect(f.createAdapters).not.toHaveBeenCalled();
      loading.resolve(fixedContext());
      const result = await running.result;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(formatRestoreLedgerReconcileCliError(result.error)).toBe('{"status":"error","code":"operation_deadline"}');
      expect(f.connectStore).not.toHaveBeenCalled(); expect(f.output).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    } finally { cancel(); await running.result; test.signal.removeEventListener("abort", cancel); vi.useRealTimers(); }
  });

  it("shares the tightened signal and joins a late connection plus its actual close before returning", async test => {
    vi.useFakeTimers();
    const f = harness(), entered = deferred<void>(), connecting = deferred<Store>();
    const closeEntered = deferred<void>(), closing = deferred<void>();
    let signal: AbortSignal | undefined;
    f.connectStore.mockImplementationOnce(async options => {
      signal = options.operationAbortSignal; entered.resolve(undefined); return connecting.promise;
    });
    f.storeClose.mockImplementationOnce(async () => { closeEntered.resolve(undefined); await closing.promise; });
    const cancel = () => { connecting.resolve(f.store); closing.resolve(undefined); };
    test.signal.addEventListener("abort", cancel, { once: true });
    const running = observe(runRestoreLedgerReconcileCli(["activate-runtime"], { ...environment("1000"),
      RESTORE_RUN_ID: "restore_00000000-0000-4000-8000-000000000001" }, f.dependencies));
    try {
      await waitForEntry(entered.promise, running.result, test.signal);
      expect(signal).toBe(f.loadAuthorityContext.mock.calls[0]![1]);
      expect(signal).toBe(f.createAdapters.mock.calls[0]![1]!.operationAbortSignal);
      await vi.advanceTimersByTimeAsync(1000); expect(signal?.aborted).toBe(true);
      expect(running.settled()).toBe(false); expect(f.storeClose).not.toHaveBeenCalled();
      connecting.resolve(f.store); await waitForEntry(closeEntered.promise, running.result, test.signal);
      expect(running.settled()).toBe(false); expect(f.read).not.toHaveBeenCalled(); expect(f.output).toEqual([]);
      expect(vi.getTimerCount()).toBe(0); // The fired timer is gone; its aborted lifetime is still joined.
      closing.resolve(undefined);
      const result = await running.result;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(formatRestoreLedgerReconcileCliError(result.error)).toBe('{"status":"error","code":"operation_deadline"}');
      expect(f.storeClose).toHaveBeenCalledOnce(); expect(f.adapterClose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    } finally { cancel(); await running.result; test.signal.removeEventListener("abort", cancel); vi.useRealTimers(); }
  });

  it("cancels an admitted adapter task without racing its original promise or starting the next boundary", async test => {
    vi.useFakeTimers();
    const f = harness(), entered = deferred<void>(), working = deferred<void>();
    f.startup.mockImplementationOnce(async () => { entered.resolve(undefined); await working.promise; });
    const cancel = () => { working.resolve(undefined); };
    test.signal.addEventListener("abort", cancel, { once: true });
    const running = observe(runRestoreLedgerReconcileCli(["activate-journal"], environment("1000"), f.dependencies));
    try {
      await waitForEntry(entered.promise, running.result, test.signal); await vi.advanceTimersByTimeAsync(1000);
      expect(f.createAdapters.mock.calls[0]![1]!.operationAbortSignal?.aborted).toBe(true);
      expect(running.settled()).toBe(false); expect(f.adapterClose).not.toHaveBeenCalled();
      expect(f.connectStore).not.toHaveBeenCalled(); working.resolve(undefined);
      const result = await running.result; expect(result.ok).toBe(false);
      expect(f.adapterClose).toHaveBeenCalledOnce(); expect(f.connectStore).not.toHaveBeenCalled();
      expect(f.output).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    } finally { cancel(); await running.result; test.signal.removeEventListener("abort", cancel); vi.useRealTimers(); }
  });

  it("preserves an undefined adapter factory rejection and removes the timer even before a resource is returned", async () => {
    vi.useFakeTimers(); const f = harness();
    f.createAdapters.mockImplementationOnce(() => { throw undefined; });
    const running = observe(runRestoreLedgerReconcileCli(["activate-journal"], environment("1000"), f.dependencies));
    try {
      const result = await running.result; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeUndefined();
      expect(f.connectStore).not.toHaveBeenCalled(); expect(f.output).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    } finally { await running.result; vi.useRealTimers(); }
  });

  it("retains the first undefined body failure while joining all real close promises and preserving the receiver", async test => {
    vi.useFakeTimers();
    const f = harness(), closeEntered = deferred<void>(), closing = deferred<void>();
    f.read.mockImplementationOnce(async function (this: unknown) { expect(this).toBe(f.store); throw undefined; });
    f.storeClose.mockRejectedValueOnce(Error("later close must not replace first failure"));
    f.adapterClose.mockImplementationOnce(async () => { closeEntered.resolve(undefined); await closing.promise; });
    const cancel = () => { closing.resolve(undefined); };
    test.signal.addEventListener("abort", cancel, { once: true });
    const running = observe(runRestoreLedgerReconcileCli(["activate-journal"], environment("1000"), f.dependencies));
    try {
      await waitForEntry(closeEntered.promise, running.result, test.signal); expect(running.settled()).toBe(false); expect(f.output).toEqual([]);
      expect(vi.getTimerCount()).toBe(1); // Timer cleanup follows the actual close promises.
      closing.resolve(undefined);
      const result = await running.result; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeUndefined();
      expect(f.read).toHaveBeenCalledOnce(); expect(f.storeClose).toHaveBeenCalledOnce();
      expect(f.adapterClose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    } finally { cancel(); await running.result; test.signal.removeEventListener("abort", cancel); vi.useRealTimers(); }
  });

  it("refuses a larger authority budget before loading a command or allocating resources", async () => {
    const f = harness();
    await expect(runRestoreLedgerReconcileCli(["activate-journal"], environment("120001"), f.dependencies))
      .rejects.toThrow("invalid_configuration");
    expect(f.loadAuthorityContext).not.toHaveBeenCalled(); expect(f.createAdapters).not.toHaveBeenCalled();
    expect(f.connectStore).not.toHaveBeenCalled(); expect(f.output).toEqual([]);
  });
});


// Common-budget negatives remain synthetic lifetime ports, not MySQL/native authority proof.
describe("restore common 120000ms stop budget", () => {
  for (const command of ["status", "prepare", "replay-fences", "verify", "abort", "run"] as const)
    it("shares one fixed budget and joins a late " + command + " connection and close", async test => {
      vi.useFakeTimers();
      const f = harness(), entered = deferred<void>(), connecting = deferred<Store>();
      const closeEntered = deferred<void>(), closing = deferred<void>();
      let signal: AbortSignal | undefined;
      f.connectStore.mockImplementationOnce(async options => {
        signal = options.operationAbortSignal; entered.resolve(undefined); return connecting.promise;
      });
      f.storeClose.mockImplementationOnce(async () => { closeEntered.resolve(undefined); await closing.promise; });
      const env: NodeJS.ProcessEnv = { MYSQL_URL: "mysql://runtime@127.0.0.1/authority_budget_test",
        MYSQL_SCHEMA_METADATA_SCHEMA: "authority_budget_metadata", MYSQL_SCHEMA_METADATA_DEFINER_USER: "metadata_definer",
        MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost", RESTORE_RUN_ID: "restore_00000000-0000-4000-8000-000000000001",
        RESTORE_FLEET_STOPPED_ACK: "1", SOURCE_BACKUP_SHA256: "a".repeat(64) };
      const cancel = () => { connecting.resolve(f.store); closing.resolve(undefined); };
      test.signal.addEventListener("abort", cancel, { once: true });
      const running = observe(runRestoreLedgerReconcileCli([command], env, f.dependencies));
      try {
        await waitForEntry(entered.promise, running.result, test.signal);
        expect(signal).toBeInstanceOf(AbortSignal); expect(signal!.aborted).toBe(false);
        if (["prepare", "replay-fences", "run"].includes(command))
          expect(f.createAdapters.mock.calls[0]![1]!.operationAbortSignal).toBe(signal);
        else expect(f.createAdapters).not.toHaveBeenCalled();
        expect(f.loadAuthorityContext).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(119_999); expect(signal!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1); expect(signal!.aborted).toBe(true);
        expect(running.settled()).toBe(false); expect(f.storeClose).not.toHaveBeenCalled();
        connecting.resolve(f.store); await waitForEntry(closeEntered.promise, running.result, test.signal);
        expect(running.settled()).toBe(false); expect(f.read).not.toHaveBeenCalled(); expect(f.output).toEqual([]);
        closing.resolve(undefined); const result = await running.result;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(formatRestoreLedgerReconcileCliError(result.error)).toBe('{"status":"error","code":"operation_deadline"}');
        expect(f.storeClose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
      } finally { cancel(); await running.result; test.signal.removeEventListener("abort", cancel); vi.useRealTimers(); }
    });

  it("keeps a ref key until a non-epoch close settles and retains the first undefined error", async test => {
    vi.useFakeTimers();
    const f = harness(), closeEntered = deferred<void>(), closing = deferred<void>(), key = Buffer.alloc(32, 0x61);
    const readRefKey = vi.fn(async () => key);
    f.read.mockImplementationOnce(async function (this: unknown) { expect(this).toBe(f.store); throw undefined; });
    f.storeClose.mockImplementationOnce(async () => { closeEntered.resolve(undefined); await closing.promise; });
    const env: NodeJS.ProcessEnv = { MYSQL_URL: "mysql://runtime@127.0.0.1/authority_budget_test",
      MYSQL_SCHEMA_METADATA_SCHEMA: "authority_budget_metadata", MYSQL_SCHEMA_METADATA_DEFINER_USER: "metadata_definer",
      MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost", TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/synthetic-restore-key" };
    const cancel = () => closing.resolve(undefined);
    test.signal.addEventListener("abort", cancel, { once: true });
    const running = observe(runRestoreLedgerReconcileCli(["status"], env, { ...f.dependencies, readRefKey }));
    try {
      await waitForEntry(closeEntered.promise, running.result, test.signal); expect(running.settled()).toBe(false);
      expect(key.equals(Buffer.alloc(32, 0x61))).toBe(true); expect(f.output).toEqual([]);
      await vi.advanceTimersByTimeAsync(120_000); expect(running.settled()).toBe(false);
      expect(key.equals(Buffer.alloc(32, 0x61))).toBe(true);
      closing.resolve(undefined); const result = await running.result;
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeUndefined();
      expect(key.equals(Buffer.alloc(32))).toBe(true); expect(f.storeClose).toHaveBeenCalledOnce();
      expect(f.createAdapters).not.toHaveBeenCalled(); expect(f.loadAuthorityContext).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { cancel(); await running.result; test.signal.removeEventListener("abort", cancel); vi.useRealTimers(); }
  });
});
