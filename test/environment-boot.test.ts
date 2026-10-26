import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// This fixture tests boot provenance independently of release packaging. The
// profile, executable/file pins, directories, journals and receipt bytes remain real.
vi.mock("../scripts/lib/vm-release.mjs", () => ({
  verifyVmReleaseDirectory: vi.fn(async () => ({ publishable: true, source: { sourceDirty: false, sourceCommit: "1".repeat(40) } })),
}));

type Json = Record<string, unknown>;
type Pin = { path: string; dev: number; ino: number; size: number; sha256: string };
type Boot = { schema: "local-environment-boot-identity-v1"; platform: string; uid: number; hostSha256: string; bootId: string };
type Witness = { pid: number; pgid: number; uid: number; started: string; executable: Pin };
type Entry = { state: string; witness: Witness; witnessBoot: Boot; failure: null; unknownSpawnPid: null;
  previousBootAbsence?: { schema: string; originalChildProcessCloseObserved: false; receiptSha256?: string } };
type Ledger = { schema: string; profilePath: string; profileSha256: string; stateDirectory: string; originalState: string;
  acceptedCommit: string; failure: string | null; activeOperation: unknown; owner: Witness; bootIdentity: Boot | null;
  bootRecovery?: { sequence?: number; receiptSha256?: string }; entries: Record<string, Entry> };
type Context = { crossBoot: boolean; currentBoot: Boot; receipt: { sha256: string; value: Json } | null };
type Dependencies = { readBootIdentity(): Promise<Boot>; assertPortUnbound(port: number): Promise<void> };
let native: { pinFile(path: string): Promise<Pin>; writePrivateJson(path: string, value: unknown, options?: { createOnly?: boolean }): Promise<{ sha256: string }> };
let bootModule: {
  isLocalBootIdentity(value: unknown): boolean; sameBootHost(a: unknown, b: unknown): boolean; sameBootIdentity(a: unknown, b: unknown): boolean;
  prepareLocalEnvironmentBootRecovery(options: { profilePath: string }, dependencies: Dependencies): Promise<{ crossBoot: boolean; receiptSha256?: string; sequence?: number }>;
  loadLocalEnvironmentBootContext(options: { profilePath: string; profileSha256: string; profile: Json; ledger: Ledger; ledgerSha256: string }, dependencies: Dependencies): Promise<Context>;
  bootContextAllowsAbsentController(context: Context, witness: Witness): boolean;
  bootContextAllowsPreviousEntry(context: Context, name: string, entry: Json): boolean;
};
beforeAll(async () => {
  native = await import(new URL("../scripts/ops/local-environment-native.mjs", import.meta.url).href) as typeof native;
  bootModule = await import(new URL("../scripts/ops/local-environment-boot.mjs", import.meta.url).href) as typeof bootModule;
});

const NAMES = ["router", "runner", "mysql", "redis"], COMMIT = "1".repeat(40), UUID = "00000000-0000-4000-8000-000000000003";
const identity = (bootId = "00000000-0000-4000-8000-000000000001"): Boot => ({ schema: "local-environment-boot-identity-v1",
  platform: "darwin", uid: process.getuid!(), hostSha256: "a".repeat(64), bootId });
const OLD_BOOT = identity(), NEW_BOOT = identity("00000000-0000-4000-8000-000000000002");
async function directoryIdentity(path: string) { const stat = await lstat(path); return [stat.dev, stat.ino, stat.uid, stat.mode].join(":"); }

async function fixture(enroll = true, legacy = false) {
  const base = process.platform === "darwin" ? "/private/tmp" : await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(base, "as-boot-"))); await chmod(directory, 0o700);
  const original = join(directory, "original"), stateDirectory = join(directory, "state"), datadir = join(original, "mysql");
  await mkdir(original, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 }); await mkdir(datadir, { mode: 0o700 });
  const marker = join(original, "retained-session.json"), auto = join(datadir, "auto.cnf"), oldLock = join(original, "owner.lock");
  await writeFile(marker, '{"session":"retained-fixture-session","messages":["before-reboot"]}\n', { mode: 0o600 });
  await writeFile(auto, `[auto]\nserver-uuid=${UUID}\n`, { mode: 0o600 });
  await writeFile(oldLock, "retained-original-controller-evidence\n", { mode: 0o600 });
  const node = await native.pinFile(await realpath(process.execPath));
  // They are deliberately old-boot fixture witnesses, never candidates for a
  // signal or a same-boot process adoption. No process is launched by this suite.
  const oldOwner: Witness = { pid: 150000, pgid: 150000, uid: process.getuid!(), started: "fixture-prior-OS-boot", executable: node };
  const entries = Object.fromEntries(NAMES.map((name, index) => [name, { state: "ready", witness: { ...oldOwner, pid: 150001 + index, pgid: 150001 + index },
    witnessBoot: OLD_BOOT, failure: null, unknownSpawnPid: null }])) as Record<string, Entry>;
  const configs = Object.fromEntries(NAMES.map((name, index) => [name, { witness: entries[name]!.witness, executable: node, cwd: original,
    args: [], env: {}, port: 41000 + index, ...(name === "mysql" ? { uuid: UUID } : {}), ...(name === "redis" ? { runId: "b".repeat(40) } : {}) }]));
  const profile = { schema: "local-environment-profile-v1", stateDirectory, originalState: original, node, acceptedCommit: COMMIT,
    abandonedControllers: [oldOwner], files: [{ path: marker, sha256: (await native.pinFile(marker)).sha256 }],
    directories: [{ path: original, identity: await directoryIdentity(original) }, { path: datadir, identity: await directoryIdentity(datadir) }],
    roles: { router: configs.router, runner: configs.runner }, infrastructure: { mysql: configs.mysql, redis: configs.redis },
    releaseBindings: ["agent-router", "agent-runner"].map(role => ({ role, directory: original, manifestSha256: "c".repeat(64) })),
    dataIdentity: { mysql: { datadir, uuid: UUID } } };
  const profilePath = join(directory, "profile.json"), profileSha256 = (await native.writePrivateJson(profilePath, profile, { createOnly: true })).sha256;
  const ledger: Ledger = { schema: "local-environment-processes-v1", profilePath, profileSha256, stateDirectory, originalState: original,
    acceptedCommit: COMMIT, failure: null, activeOperation: null, owner: { ...oldOwner, pid: 150100, pgid: 150100 },
    bootIdentity: legacy ? null : OLD_BOOT, entries };
  const ledgerPath = join(stateDirectory, "processes.json"), journalPath = join(stateDirectory, "operations.json");
  let ledgerSha256 = (await native.writePrivateJson(ledgerPath, ledger, { createOnly: true })).sha256;
  const journalSha256 = (await native.writePrivateJson(journalPath, { schema: "local-environment-journal-v1", operations: [], currentId: null }, { createOnly: true })).sha256;
  const enrollmentPath = join(stateDirectory, "boot-enrollment.json");
  if (enroll) await native.writePrivateJson(enrollmentPath, { schema: "local-environment-boot-enrollment-v1", profilePath, profileSha256,
    boot: OLD_BOOT, owner: ledger.owner, ledgerSha256, journalSha256, abandonedControllers: [oldOwner], dataIdentityPins: [await native.pinFile(auto)],
    observedAt: "2026-10-26T12:00:00.000Z", originalRecordsRetained: true, modelCalls: 0 }, { createOnly: true });
  const retained = await Promise.all([profilePath, ledgerPath, marker, oldLock, auto].map(path => readFile(path)));
  const dependencies = { readBootIdentity: vi.fn(async () => structuredClone(NEW_BOOT)), assertPortUnbound: vi.fn(async (_port: number) => {}) };
  return { directory, original, stateDirectory, marker, auto, oldLock, oldOwner, profile, profilePath, profileSha256, ledger, ledgerPath, journalPath,
    dependencies, enrollmentPath,
    async prepare(selectedDependencies: Dependencies = dependencies) { return bootModule.prepareLocalEnvironmentBootRecovery({ profilePath }, selectedDependencies); },
    async load(selectedDependencies: Dependencies = dependencies) {
      return bootModule.loadLocalEnvironmentBootContext({ profilePath, profileSha256, profile, ledger, ledgerSha256 }, selectedDependencies);
    },
    async saveLedger() { ledgerSha256 = (await native.writePrivateJson(ledgerPath, ledger)).sha256; },
    async receipts() { return (await readdir(stateDirectory)).filter(name => /^boot-recovery-\d{6}\.json$/.test(name)).sort(); },
    async unchanged() { const observed = await Promise.all([profilePath, ledgerPath, marker, oldLock, auto].map(path => readFile(path))); expect(observed).toEqual(retained); },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("local environment host and OS boot identity", () => {
  it("distinguishes a new OS boot from a new host or user", () => {
    expect(bootModule.isLocalBootIdentity(OLD_BOOT)).toBe(true);
    expect(bootModule.sameBootIdentity(OLD_BOOT, structuredClone(OLD_BOOT))).toBe(true);
    expect(bootModule.sameBootHost(OLD_BOOT, NEW_BOOT)).toBe(true); expect(bootModule.sameBootIdentity(OLD_BOOT, NEW_BOOT)).toBe(false);
    for (const changed of [{ platform: "linux" }, { uid: OLD_BOOT.uid + 1 }, { hostSha256: "d".repeat(64) }]) {
      expect(bootModule.sameBootHost(OLD_BOOT, { ...OLD_BOOT, ...changed })).toBe(false);
      expect(bootModule.sameBootIdentity(OLD_BOOT, { ...OLD_BOOT, ...changed })).toBe(false);
    }
    for (const bad of [null, {}, { ...OLD_BOOT, bootId: "wall-clock-or-pid" }, { ...OLD_BOOT, hostSha256: "host-name" }, { ...OLD_BOOT, uid: -1 }]) {
      expect(bootModule.isLocalBootIdentity(bad)).toBe(false);
    }
  });
});

describe("append-only recovery proof for an enrolled retained environment", () => {
  it("records one cross-boot absence proof without probing or signaling old PIDs, and reuses it on a repeated prepare", async () => {
    const f = await fixture(), signal = vi.spyOn(process, "kill");
    try {
      const result = await f.prepare(); expect(result).toMatchObject({ crossBoot: true, sequence: 1 });
      expect(f.dependencies.assertPortUnbound.mock.calls.map(args => args[0])).toEqual([41000, 41001, 41002, 41003]);
      const path = join(f.stateDirectory, "boot-recovery-000001.json"), bytes = await readFile(path);
      const receipt = JSON.parse(bytes.toString("utf8"));
      expect(receipt).toMatchObject({ schema: "local-environment-boot-recovery-v1", sequence: 1, previousReceiptSha256: null,
        previousBoot: OLD_BOOT, currentBoot: NEW_BOOT, originalChildProcessCloseObserved: false, originalRecordsRetained: true,
        dataInitialized: false, ddlExecuted: false, modelCalls: 0 });
      expect(receipt.entries.router.witness).toEqual(f.ledger.entries.router!.witness);
      expect(await f.prepare()).toEqual(result); expect(await f.receipts()).toEqual(["boot-recovery-000001.json"]);
      expect(await readFile(path)).toEqual(bytes); expect(signal).not.toHaveBeenCalled(); await f.unchanged();
    } finally { signal.mockRestore(); await f.close(); }
  });

  it("does not grant cross-boot absence on the same boot or manufacture a child close", async () => {
    const f = await fixture(), dependencies = { ...f.dependencies, readBootIdentity: async () => OLD_BOOT };
    try {
      expect(await f.prepare(dependencies)).toEqual({ crossBoot: false, boot: OLD_BOOT });
      const context = await f.load(dependencies);
      expect(context.crossBoot).toBe(false); expect(bootModule.bootContextAllowsAbsentController(context, f.oldOwner)).toBe(false);
      expect(f.dependencies.assertPortUnbound).not.toHaveBeenCalled(); expect(await f.receipts()).toEqual([]); await f.unchanged();
    } finally { await f.close(); }
  });

  it("permits the exact enrolled legacy ledger to acquire its first cross-boot proof without rewriting it", async () => {
    const f = await fixture(true, true);
    try {
      expect(await f.prepare()).toMatchObject({ crossBoot: true, sequence: 1 });
      expect((await f.load()).crossBoot).toBe(true); expect(f.ledger.bootIdentity).toBeNull(); await f.unchanged();
    } finally { await f.close(); }
  });

  it.each(["ledger", "journal"])("rejects a changed unstamped legacy %s instead of treating it as enrollment evidence", async source => {
    const f = await fixture(true, true);
    try {
      if (source === "ledger") {
        f.ledger.entries.router!.witness.pid++; await f.saveLedger();
      } else {
        const id = "00000000-0000-4000-8000-000000000004";
        await native.writePrivateJson(f.journalPath, { schema: "local-environment-journal-v1", currentId: id, operations: [
          { id, action: "start-services", state: "succeeded", phase: "completed", startedAt: "2026-10-26T12:00:00.000Z",
            finishedAt: "2026-10-26T12:00:01.000Z", error: null },
        ] });
      }
      await expect(f.prepare()).rejects.toThrow("environment_boot_bindings_changed");
      await expect(f.load()).rejects.toThrow("environment_boot_bindings_changed");
      expect(await f.receipts()).toEqual([]); expect(f.dependencies.assertPortUnbound).not.toHaveBeenCalled();
      expect(await readFile(f.oldLock, "utf8")).toBe("retained-original-controller-evidence\n");
      expect(await readFile(f.marker, "utf8")).toContain("before-reboot");
    } finally { await f.close(); }
  });

  it("retains a valid stopped witness across two OS reboots while requiring the latest exact recovery selector", async () => {
    const f = await fixture(), thirdBoot = identity("00000000-0000-4000-8000-000000000005");
    try {
      const first = await f.prepare(), firstPath = join(f.stateDirectory, "boot-recovery-000001.json"), firstBytes = await readFile(firstPath);
      f.ledger.bootIdentity = NEW_BOOT; f.ledger.bootRecovery = { sequence: first.sequence, receiptSha256: first.receiptSha256 };
      for (const name of NAMES) {
        const entry = f.ledger.entries[name]!; entry.state = "stopped";
        entry.previousBootAbsence = { schema: "local-environment-previous-boot-absence-v1", originalChildProcessCloseObserved: false,
          receiptSha256: first.receiptSha256 };
      }
      await f.saveLedger();
      const dependencies = { ...f.dependencies, readBootIdentity: async () => thirdBoot };
      const second = await f.prepare(dependencies); expect(second).toMatchObject({ crossBoot: true, sequence: 2 });
      expect(second.receiptSha256).not.toBe(first.receiptSha256);
      const receipt = JSON.parse(await readFile(join(f.stateDirectory, "boot-recovery-000002.json"), "utf8"));
      expect(receipt).toMatchObject({ previousReceiptSha256: first.receiptSha256, previousBoot: NEW_BOOT, currentBoot: thirdBoot });
      const context = await f.load(dependencies); expect(context.crossBoot).toBe(true); expect(context.receipt?.sha256).toBe(second.receiptSha256);
      for (const name of NAMES) {
        const oldEntry = f.ledger.entries[name]!;
        expect(bootModule.bootContextAllowsPreviousEntry(context, name, oldEntry)).toBe(false);
        const recoveredEntry = { ...oldEntry, previousBootAbsence: { ...oldEntry.previousBootAbsence, receiptSha256: second.receiptSha256 } };
        expect(bootModule.bootContextAllowsPreviousEntry(context, name, recoveredEntry)).toBe(true);
      }
      expect(await f.receipts()).toEqual(["boot-recovery-000001.json", "boot-recovery-000002.json"]);
      expect(await readFile(firstPath)).toEqual(firstBytes);
      expect(await readFile(f.marker, "utf8")).toContain("before-reboot");
      expect(await readFile(f.oldLock, "utf8")).toBe("retained-original-controller-evidence\n");
    } finally { await f.close(); }
  });

  it("requires the exact immutable receipt before permitting the driver to treat old-boot witnesses as stopped", async () => {
    const f = await fixture();
    try {
      await expect(f.load()).rejects.toThrow("environment_boot_recovery_required");
      const prepared = await f.prepare(), context = await f.load();
      expect(context.crossBoot).toBe(true); expect(context.receipt?.sha256).toBe(prepared.receiptSha256);
      expect(bootModule.bootContextAllowsAbsentController(context, f.oldOwner)).toBe(true);
      expect(bootModule.bootContextAllowsAbsentController(context, { ...f.oldOwner, pid: f.oldOwner.pid + 100 })).toBe(false);
      const entry = { ...f.ledger.entries.router!, state: "stopped", previousBootAbsence: {
        schema: "local-environment-previous-boot-absence-v1", originalChildProcessCloseObserved: false, receiptSha256: prepared.receiptSha256 } };
      expect(bootModule.bootContextAllowsPreviousEntry(context, "router", entry)).toBe(true);
      expect(bootModule.bootContextAllowsPreviousEntry(context, "router", { ...entry, state: "ready" })).toBe(false);
      expect(bootModule.bootContextAllowsPreviousEntry(context, "router", { ...entry, witness: { ...entry.witness, pid: entry.witness.pid + 1 } })).toBe(false);
      expect(bootModule.bootContextAllowsPreviousEntry(context, "router", { ...entry,
        previousBootAbsence: { ...entry.previousBootAbsence, receiptSha256: "f".repeat(64) } })).toBe(false);
      expect(bootModule.bootContextAllowsPreviousEntry(context, "router", { ...entry,
        previousBootAbsence: { ...entry.previousBootAbsence, originalChildProcessCloseObserved: true } })).toBe(false);
      await f.unchanged();
    } finally { await f.close(); }
  });

  it("retains an unknown listener and refuses to create a recovery receipt", async () => {
    const f = await fixture(), signal = vi.spyOn(process, "kill");
    try {
      const dependencies = { ...f.dependencies, assertPortUnbound: vi.fn(async (port: number) => { if (port === 41002) throw new Error("environment_boot_port_in_use"); }) };
      await expect(f.prepare(dependencies)).rejects.toThrow("environment_boot_port_in_use");
      expect(await f.receipts()).toEqual([]); expect(signal).not.toHaveBeenCalled(); await f.unchanged();
    } finally { signal.mockRestore(); await f.close(); }
  });

  it.each(["running", "unknown", "failed"])("blocks recovery of a retained %s journal operation", async state => {
    const f = await fixture();
    try {
      await native.writePrivateJson(f.journalPath, { schema: "local-environment-journal-v1", currentId: "fixture-id", operations: [
        { id: "fixture-id", action: "stop-infrastructure", state, error: null, finishedAt: "2026-10-26T12:00:00.000Z" },
      ] });
      await expect(f.prepare()).rejects.toThrow("environment_boot_unsettled");
      expect(f.dependencies.assertPortUnbound).not.toHaveBeenCalled(); expect(await f.receipts()).toEqual([]); await f.unchanged();
    } finally { await f.close(); }
  });

  it.each(["starting", "stopping", "unknown"])("blocks recovery of an unresolved %s process entry", async state => {
    const f = await fixture();
    try {
      f.ledger.entries.router!.state = state; await f.saveLedger();
      await expect(f.prepare()).rejects.toThrow("environment_boot_unsettled");
      expect(await f.receipts()).toEqual([]); expect(f.dependencies.assertPortUnbound).not.toHaveBeenCalled();
      expect(await readFile(f.oldLock, "utf8")).toBe("retained-original-controller-evidence\n");
    } finally { await f.close(); }
  });

  it("refuses changed retained data or MySQL identity before making an absence claim", async () => {
    const f = await fixture();
    try {
      await writeFile(f.auto, `[auto]\nserver-uuid=${"f".repeat(36)}\n`, { mode: 0o600 });
      await expect(f.prepare()).rejects.toThrow("environment_boot_data_changed");
      expect(await f.receipts()).toEqual([]); expect(f.dependencies.assertPortUnbound).not.toHaveBeenCalled();
      expect(await readFile(f.marker, "utf8")).toContain("before-reboot");
    } finally { await f.close(); }
  });

  it("refuses a changed pinned input without creating a recovery receipt", async () => {
    const f = await fixture();
    try {
      await writeFile(f.marker, '{"changed":"fixture input"}\n', { mode: 0o600 });
      await expect(f.prepare()).rejects.toThrow("environment_boot_bindings_changed");
      expect(await f.receipts()).toEqual([]); expect(f.dependencies.assertPortUnbound).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("rejects another host, an unenrolled environment and a modified receipt chain", async () => {
    const f = await fixture(), unenrolled = await fixture(false);
    try {
      await expect(f.prepare({ ...f.dependencies, readBootIdentity: async () => ({ ...NEW_BOOT, hostSha256: "f".repeat(64) }) })).rejects.toThrow();
      await expect(unenrolled.prepare()).rejects.toThrow("environment_boot_enrollment_required");
      await f.prepare(); const receipt = join(f.stateDirectory, "boot-recovery-000001.json");
      const changed = JSON.parse(await readFile(receipt, "utf8")); changed.sourceLedgerSha256 = "e".repeat(64);
      await native.writePrivateJson(receipt, changed);
      await expect(f.load()).rejects.toThrow("environment_boot_recovery_required");
      expect(await f.receipts()).toEqual(["boot-recovery-000001.json"]); expect(await unenrolled.receipts()).toEqual([]);
    } finally { await f.close(); await unenrolled.close(); }
  });
});
