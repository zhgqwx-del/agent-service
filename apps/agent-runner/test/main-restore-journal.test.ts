import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL,
  MemorySessionStore,
  MemoryTenantRestoreJournalAdapter,
  MysqlSessionStore,
  S3TenantRestoreJournalAdapter,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_REMOTE_HEAD_SCOPE,
  type TenantRestoreJournalTargetDescriptor,
} from "@agent-service/store";
import { TenantRestoreJournalPublicationWorker } from "@agent-service/core";

const mockedServer = vi.hoisted(() => ({
  listening: false,
  close(callback?: () => void) {
    this.listening = false;
    callback?.();
    return this;
  },
}));

vi.mock("@hono/node-server", () => ({
  serve: () => {
    mockedServer.listening = true;
    return mockedServer;
  },
}));

vi.mock("../src/blob-storage-migration-gate.js", () => ({
  assertBlobStorageMigrationRuntimeReady: vi.fn(async () => {}),
}));

import { loadConfig } from "../src/config.js";
import { startRunner } from "../src/main.js";
import { assertBlobStorageMigrationRuntimeReady } from
  "../src/blob-storage-migration-gate.js";

const MASTER_KEY = "99".repeat(32);
const INTERNAL_TOKEN = "restore-main-private-router-token-0001";
const journalEnv = {
  NODE_ENV: "test",
  STORE: "mysql",
  MYSQL_URL: "mysql://unused",
  SECRETS_MASTER_KEY: MASTER_KEY,
  RUNNER_PORT: "0",
  RUNNER_ADDR: "127.0.0.1:0",
  RESTORE_JOURNAL_ADAPTER: "s3",
  RESTORE_JOURNAL_DATABASE_NAMESPACE_ID: "runner-main-logical-db-v1",
  RESTORE_JOURNAL_RUNTIME_EPOCH_ID: "runner-main-primary-epoch-v1",
  RESTORE_JOURNAL_NAMESPACE_ID: "runner-main-journal-v1",
  RESTORE_JOURNAL_FAILURE_DOMAIN_ID: "runner-main-independent-domain-v1",
  RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
  RESTORE_JOURNAL_S3_ENDPOINT: "http://127.0.0.1:9000",
  RESTORE_JOURNAL_S3_BUCKET: "runner-main-restore-journal-test",
  RESTORE_JOURNAL_S3_FORCE_PATH_STYLE: "1",
  INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
} satisfies NodeJS.ProcessEnv;

function emptyObservedHead(
  descriptor: TenantRestoreJournalTargetDescriptor,
  logicalDatabaseNamespaceSha256: string,
) {
  return {
    ...descriptor,
    logicalDatabaseNamespaceSha256,
    sealedRemoteSequence: 0,
    sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  };
}

async function activateConfiguredJournal(
  store: MemorySessionStore,
  env: NodeJS.ProcessEnv = journalEnv,
) {
  const config = loadConfig(env).tenantRestoreJournal!;
  const descriptors = config.targets.map((target) => target.descriptor);
  await store.activateTenantRestoreJournalControl({
    adapterProtocol: config.adapterProtocol,
    journalNamespaceSha256: config.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
    runtimeEpochSha256: config.runtimeEpochSha256,
    targets: descriptors,
    observedHeads: descriptors.map((descriptor) => emptyObservedHead(
      descriptor,
      config.logicalDatabaseNamespaceSha256,
    )),
  });
}

describe("runner restore journal startup wiring", () => {
  let blobDir: string;

  beforeEach(async () => {
    blobDir = await mkdtemp(join(tmpdir(), "agent-runner-restore-journal-"));
    mockedServer.listening = false;
    vi.mocked(assertBlobStorageMigrationRuntimeReady).mockClear();
    vi.mocked(assertBlobStorageMigrationRuntimeReady).mockResolvedValue();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(blobDir, { recursive: true, force: true });
  });

  function stubS3Adapter() {
    const validateStartup = vi.spyOn(
      S3TenantRestoreJournalAdapter.prototype,
      "validateStartup",
    ).mockResolvedValue();
    const readHead = vi.spyOn(
      S3TenantRestoreJournalAdapter.prototype,
      "readHead",
    ).mockImplementation(async function (this: S3TenantRestoreJournalAdapter) {
      return {
        scope: TENANT_RESTORE_JOURNAL_REMOTE_HEAD_SCOPE,
        protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
        adapterProtocol: this.adapterProtocol,
        journalNamespaceSha256: this.journalNamespaceSha256,
        targetSha256: this.targetSha256,
        logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
        remoteSequence: 0,
        headRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
      };
    });
    const close = vi.spyOn(
      S3TenantRestoreJournalAdapter.prototype,
      "close",
    ).mockResolvedValue();
    return { validateStartup, readHead, close };
  }

  it("preflights before the existing MySQL gates and closes a dormant adapter once", async () => {
    const store = new MemorySessionStore();
    const control = vi.spyOn(store, "getTenantRestoreJournalControl");
    vi.spyOn(MysqlSessionStore, "connect").mockResolvedValue(store as never);
    const adapter = stubS3Adapter();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({ ...journalEnv, BLOB_DIR: blobDir });
      expect(runner.tenantRestoreJournalPreflight).toMatchObject({
        state: "inactive",
        configured: true,
        targetCount: 1,
      });
      expect(adapter.validateStartup).toHaveBeenCalledOnce();
      expect(adapter.close).toHaveBeenCalledOnce();
      expect(control.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(assertBlobStorageMigrationRuntimeReady).mock.invocationCallOrder[0]!,
      );
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: {
          tenantRestoreJournal: ["independent-restore-journal-v1"],
          tenantRestoreJournalWorker: false,
          tenantRestoreJournalNamespaceSha256:
            runner.cfg.tenantRestoreJournal!.journalNamespaceSha256,
          tenantRestoreJournalTargetRootSha256:
            runner.cfg.tenantRestoreJournal!.targetRootSha256,
          tenantRestoreRuntimeEpochSha256:
            runner.cfg.tenantRestoreJournal!.runtimeEpochSha256,
        },
      });
      await runner.close();
      runner = undefined;
      expect(adapter.close).toHaveBeenCalledOnce();
    } finally {
      await runner?.close();
      log.mockRestore();
    }
  });

  it("starts and gracefully stops the embedded publisher without double-closing its adapter", async () => {
    const store = new MemorySessionStore();
    vi.spyOn(MysqlSessionStore, "connect").mockResolvedValue(store as never);
    const adapter = stubS3Adapter();
    const start = vi.spyOn(TenantRestoreJournalPublicationWorker.prototype, "start")
      .mockImplementation(() => {});
    const stop = vi.spyOn(TenantRestoreJournalPublicationWorker.prototype, "stop");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        ...journalEnv,
        BLOB_DIR: blobDir,
        ERASURE_ROUTER_URL: "http://router.internal",
        TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "1",
        TENANT_RESTORE_JOURNAL_WORKER_POLL_MS: "60000",
      });
      expect(runner.tenantRestoreJournalGate).toBeDefined();
      expect(runner.tenantRestoreJournalWorker)
        .toBeInstanceOf(TenantRestoreJournalPublicationWorker);
      expect(start).toHaveBeenCalledOnce();
      expect(adapter.close).not.toHaveBeenCalled();
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: { tenantRestoreJournalWorker: true },
      });
      await runner.close();
      runner = undefined;
      expect(stop).toHaveBeenCalledOnce();
      expect(adapter.close).toHaveBeenCalledOnce();
    } finally {
      await runner?.close();
      log.mockRestore();
    }
  });

  it("fails before all later startup work when durable journal control is active without a worker", async () => {
    const store = new MemorySessionStore();
    await activateConfiguredJournal(store);
    const storeClose = vi.spyOn(store, "close");
    vi.spyOn(MysqlSessionStore, "connect").mockResolvedValue(store as never);
    const adapter = stubS3Adapter();
    const bootstrap = vi.spyOn(store, "createApiKey");
    await expect(startRunner({
      ...journalEnv,
      BLOB_DIR: blobDir,
      BOOTSTRAP_API_KEY: "must-not-be-written",
    })).rejects.toThrow(
      "TENANT_RESTORE_JOURNAL_WORKER_ENABLED=1 is required after durable restore journal activation",
    );
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(assertBlobStorageMigrationRuntimeReady).not.toHaveBeenCalled();
    expect(mockedServer.listening).toBe(false);
  });

  it("fails closed on missing configuration and never exposes adapter failure details", async () => {
    const missingConfigStore = new MemorySessionStore();
    const memoryAdapter = new MemoryTenantRestoreJournalAdapter({
      nonProductionFixture: true,
      namespaceId: "missing-config-journal-v1",
      failureDomainId: "missing-config-domain-v1",
      targetId: "missing-config-target-v1",
      logicalDatabaseNamespaceSha256: "11".repeat(32),
    });
    const descriptor: TenantRestoreJournalTargetDescriptor = {
      targetOrdinal: 0,
      targetSha256: memoryAdapter.targetSha256,
      failureDomainSha256: memoryAdapter.failureDomainSha256,
      adapterProtocol: MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL,
      journalNamespaceSha256: memoryAdapter.journalNamespaceSha256,
    };
    await missingConfigStore.activateTenantRestoreJournalControl({
      adapterProtocol: descriptor.adapterProtocol,
      journalNamespaceSha256: descriptor.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256: memoryAdapter.logicalDatabaseNamespaceSha256,
      runtimeEpochSha256: "22".repeat(32),
      targets: [descriptor],
      observedHeads: [emptyObservedHead(
        descriptor,
        memoryAdapter.logicalDatabaseNamespaceSha256,
      )],
    });
    vi.spyOn(MysqlSessionStore, "connect").mockResolvedValueOnce(missingConfigStore as never);
    await expect(startRunner({
      NODE_ENV: "test",
      STORE: "mysql",
      MYSQL_URL: "mysql://unused",
      SECRETS_MASTER_KEY: MASTER_KEY,
      RUNNER_PORT: "0",
      RUNNER_ADDR: "127.0.0.1:0",
      BLOB_DIR: blobDir,
    })).rejects.toThrow("tenant restore journal preflight failed (missing_configuration)");
    expect(assertBlobStorageMigrationRuntimeReady).not.toHaveBeenCalled();

    const unsafeStore = new MemorySessionStore();
    vi.spyOn(MysqlSessionStore, "connect").mockResolvedValueOnce(unsafeStore as never);
    const adapter = stubS3Adapter();
    adapter.validateStartup.mockRejectedValueOnce(
      new Error("credential=do-not-leak locator=s3://private-journal"),
    );
    let message = "";
    try {
      await startRunner({ ...journalEnv, BLOB_DIR: blobDir });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "tenant restore journal preflight failed (adapter_validation_failed)",
    );
    expect(message).not.toContain("do-not-leak");
    expect(message).not.toContain("s3://");
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(assertBlobStorageMigrationRuntimeReady).not.toHaveBeenCalled();
    expect(mockedServer.listening).toBe(false);
    await memoryAdapter.close();
  });
});
