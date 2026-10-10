import {
  BlobConflictError,
  BlobStorageMigrationConflictError,
  BlobStorageMigrationIntegrityError,
  BlobStorageMigrationNotReadyError,
  BlobTooLargeError,
  type BlobMigrationStore,
} from "@agent-service/store";
import { describe, expect, it, vi } from "vitest";
import {
  formatBlobStorageMigrationCliError,
  runBlobStorageMigrationCli,
  type BlobStorageMigrationCliCoordinator,
  type BlobStorageMigrationCliDependencies,
} from "../src/blob-storage-migrate-cli.js";
import { main as migrationCliMain } from "../src/blob-storage-migrate.js";

const SOURCE_NAMESPACE = "a".repeat(64);
const TARGET_NAMESPACE = "b".repeat(64);
const TARGET_BACKEND = `s3-v1-${TARGET_NAMESPACE.slice(0, 24)}`;
const FLEET_EVIDENCE = "c".repeat(64);
const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;

const FULL_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  MYSQL_URL: "mysql://migration_user:unit-test-password@db.internal/agent_service",
  BLOB_DIR: "/private/unit-test/blob-source",
  BLOB_NAMESPACE_ID: "unit-test-target-v1",
  BLOB_S3_ENDPOINT: "http://minio.internal:9000/",
  BLOB_S3_REGION: "us-east-1",
  BLOB_S3_BUCKET: "unit-test-private-bucket",
  BLOB_S3_PREFIX: "agent-service-v1",
  BLOB_S3_FORCE_PATH_STYLE: "1",
  BLOB_S3_ACCESS_KEY_ID: "unit-test-access-key",
  BLOB_S3_SECRET_ACCESS_KEY: "unit-test-secret-key",
  MIGRATION_ID: "migration-001",
  FLEET_DRAINED_EVIDENCE_SHA256: FLEET_EVIDENCE,
  ROLLBACK_WINDOW_MS: "60000",
  SOURCE_CLEANUP_DELAY_MS: "120000",
};

function durableControl(overrides: Record<string, unknown> = {}) {
  return {
    singletonId: 1,
    controlGeneration: 7,
    phase: "verified",
    migrationId: "must-not-be-emitted",
    sourceBackend: "filesystem-v1",
    sourceNamespaceSha256: SOURCE_NAMESPACE,
    targetBackend: TARGET_BACKEND,
    targetNamespaceSha256: TARGET_NAMESPACE,
    fleetDrainedEvidenceSha256: FLEET_EVIDENCE,
    inventoryEntryCount: 5,
    inventoryRootSha256: "d".repeat(64),
    objectAckCount: 3,
    objectAckRootSha256: "e".repeat(64),
    ...overrides,
  };
}

function migrationStore(backend: string, namespaceSha256: string): BlobMigrationStore {
  return {
    backend,
    namespaceSha256,
    putIfAbsent: vi.fn(),
    get: vi.fn(),
    getExact: vi.fn(),
    delete: vi.fn(),
    inspectExact: vi.fn(),
    discardUncommittedTarget: vi.fn(),
  } as unknown as BlobMigrationStore;
}

function harness(control = durableControl()) {
  const source = migrationStore("filesystem-v1", SOURCE_NAMESPACE);
  const target = {
    ...migrationStore(TARGET_BACKEND, TARGET_NAMESPACE),
    validateStartup: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const coordinator: BlobStorageMigrationCliCoordinator = {
    close: vi.fn(async () => undefined),
    getControl: vi.fn(async () => control),
    prepare: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    verify: vi.fn(async () => undefined),
    cutover: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    cleanupSource: vi.fn(async () => undefined),
  };
  const lines: string[] = [];
  const dependencies: BlobStorageMigrationCliDependencies = {
    connectCoordinator: vi.fn(async () => coordinator),
    createSource: vi.fn(() => source),
    createTarget: vi.fn(() => target),
    writeLine: vi.fn((line) => { lines.push(line); }),
  };
  return { source, target, coordinator, dependencies, lines };
}

async function formattedFailure(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    throw new Error("expected operation to reject");
  } catch (error) {
    return formatBlobStorageMigrationCliError(error);
  }
}

describe("blob-storage-migrate CLI", () => {
  it("keeps help resource-free but does not let help mask unknown argv", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(migrationCliMain(["--help"], {})).resolves.toBe(0);
      expect(stdout).toHaveBeenCalledOnce();
      expect(String(stdout.mock.calls[0]![0])).toContain("Usage: blob-storage-migrate");
      expect(String(stdout.mock.calls[0]![0])).toContain("status");

      await expect(migrationCliMain([
        "--help",
        "--mysql-url=mysql://user:secret@db/private",
      ], {})).resolves.toBe(1);
      expect(stderr).toHaveBeenCalledWith('{"status":"error","code":"invalid_command"}');
      expect(String(stderr.mock.calls[0]![0])).not.toContain("secret");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("performs a content-free status read and emits only the bounded public summary", async () => {
    const h = harness();
    await expect(runBlobStorageMigrationCli(
      ["status"],
      { MYSQL_URL: FULL_ENV.MYSQL_URL },
      h.dependencies,
    )).resolves.toBe(0);

    expect(h.dependencies.createSource).not.toHaveBeenCalled();
    expect(h.dependencies.createTarget).not.toHaveBeenCalled();
    expect(h.coordinator.getControl).toHaveBeenCalledOnce();
    expect(h.coordinator.close).toHaveBeenCalledOnce();
    expect(h.lines).toHaveLength(1);
    expect(JSON.parse(h.lines[0]!)).toEqual({
      status: "ok",
      command: "status",
      phase: "verified",
      controlGeneration: 7,
      inventoryEntryCount: 5,
      objectAckCount: 3,
      sourceBackend: "filesystem-v1",
      targetBackend: "s3-v1",
    });
    expect(h.lines[0]).not.toContain("must-not-be-emitted");
    expect(h.lines[0]).not.toContain(SOURCE_NAMESPACE);
    expect(h.lines[0]).not.toContain(TARGET_NAMESPACE);
    expect(h.lines[0]).not.toContain("password");
  });

  it("rejects missing, extra, flag, and unknown argv before opening any resource", async () => {
    const h = harness();
    for (const argv of [
      [],
      ["status", "extra"],
      ["--mysql-url=mysql://user:secret@db/private"],
      ["prepare", "--force"],
      ["unknown"],
    ]) {
      await expect(formattedFailure(
        runBlobStorageMigrationCli(argv, FULL_ENV, h.dependencies),
      )).resolves.toBe('{"status":"error","code":"invalid_command"}');
    }
    expect(h.dependencies.connectCoordinator).not.toHaveBeenCalled();
    expect(h.dependencies.createSource).not.toHaveBeenCalled();
    expect(h.dependencies.createTarget).not.toHaveBeenCalled();
  });

  it("prepares with the current durable generation and env-only source/target identity", async () => {
    const h = harness();
    vi.mocked(h.coordinator.getControl)
      .mockResolvedValueOnce(durableControl({
        controlGeneration: 11,
        phase: "aborted",
      }))
      .mockResolvedValueOnce(durableControl({
        controlGeneration: 12,
        phase: "inventory_sealed",
      }));

    await expect(runBlobStorageMigrationCli(["prepare"], FULL_ENV, h.dependencies)).resolves.toBe(0);

    expect(h.dependencies.createSource).toHaveBeenCalledWith(FULL_ENV.BLOB_DIR);
    expect(h.dependencies.createTarget).toHaveBeenCalledOnce();
    const targetOptions = vi.mocked(h.dependencies.createTarget).mock.calls[0]![0];
    expect(targetOptions).toMatchObject({
      bucket: FULL_ENV.BLOB_S3_BUCKET,
      namespaceId: FULL_ENV.BLOB_NAMESPACE_ID,
      prefix: FULL_ENV.BLOB_S3_PREFIX,
      requestTimeoutMs: 5_000,
      clientConfig: {
        region: "us-east-1",
        endpoint: "http://minio.internal:9000",
        forcePathStyle: true,
        credentials: {
          accessKeyId: FULL_ENV.BLOB_S3_ACCESS_KEY_ID,
          secretAccessKey: FULL_ENV.BLOB_S3_SECRET_ACCESS_KEY,
        },
      },
    });
    expect(h.target.validateStartup).toHaveBeenCalledOnce();
    expect(h.coordinator.prepare).toHaveBeenCalledWith(
      h.source,
      h.target,
      {
        migrationId: "migration-001",
        expectedControlGeneration: 11,
        sourceBackend: "filesystem-v1",
        sourceNamespaceSha256: SOURCE_NAMESPACE,
        targetBackend: TARGET_BACKEND,
        targetNamespaceSha256: TARGET_NAMESPACE,
        fleetDrainedEvidenceSha256: FLEET_EVIDENCE,
        rollbackWindowMs: 60_000,
        sourceCleanupDelayMs: 120_000,
      },
      DEFAULT_MAX_OBJECT_BYTES,
    );
    expect(h.coordinator.getControl).toHaveBeenCalledTimes(2);
    expect(h.target.close).toHaveBeenCalledOnce();
    const output = h.lines[0]!;
    for (const forbidden of [
      FULL_ENV.BLOB_DIR!,
      FULL_ENV.BLOB_S3_ENDPOINT!,
      FULL_ENV.BLOB_S3_ACCESS_KEY_ID!,
      FULL_ENV.BLOB_S3_SECRET_ACCESS_KEY!,
      FULL_ENV.MIGRATION_ID!,
      FLEET_EVIDENCE,
    ]) expect(output).not.toContain(forbidden);
  });

  it("keeps abort target-only and makes cleanup-source revalidate both stores", async () => {
    const abort = harness(durableControl({ phase: "aborted" }));
    const abortEnv: NodeJS.ProcessEnv = {
      MYSQL_URL: FULL_ENV.MYSQL_URL,
      BLOB_NAMESPACE_ID: FULL_ENV.BLOB_NAMESPACE_ID,
      BLOB_S3_BUCKET: FULL_ENV.BLOB_S3_BUCKET,
    };
    await runBlobStorageMigrationCli(["abort"], abortEnv, abort.dependencies);
    expect(abort.dependencies.createSource).not.toHaveBeenCalled();
    expect(abort.target.validateStartup).toHaveBeenCalledOnce();
    expect(abort.coordinator.abort).toHaveBeenCalledWith(
      abort.target,
      DEFAULT_MAX_OBJECT_BYTES,
    );

    const cleanup = harness(durableControl({ phase: "source_cleaned" }));
    await runBlobStorageMigrationCli(["cleanup-source"], FULL_ENV, cleanup.dependencies);
    expect(cleanup.dependencies.createSource).toHaveBeenCalledOnce();
    expect(cleanup.dependencies.createTarget).toHaveBeenCalledOnce();
    expect(cleanup.target.validateStartup).toHaveBeenCalledOnce();
    expect(cleanup.coordinator.cleanupSource).toHaveBeenCalledWith(
      cleanup.source,
      cleanup.target,
      DEFAULT_MAX_OBJECT_BYTES,
    );

    const incomplete = harness();
    await expect(formattedFailure(runBlobStorageMigrationCli(["cleanup-source"], {
      MYSQL_URL: FULL_ENV.MYSQL_URL,
      BLOB_DIR: FULL_ENV.BLOB_DIR,
    }, incomplete.dependencies))).resolves.toBe(
      '{"status":"error","code":"invalid_configuration"}',
    );
    expect(incomplete.dependencies.connectCoordinator).not.toHaveBeenCalled();
  });

  it("runs through verified by default and never folds source cleanup into committed run", async () => {
    const safe = harness();
    vi.mocked(safe.coordinator.getControl)
      .mockResolvedValueOnce(durableControl({ controlGeneration: 4, phase: "inactive" }))
      .mockResolvedValueOnce(durableControl({ controlGeneration: 5, phase: "verified" }));
    await runBlobStorageMigrationCli(["run"], FULL_ENV, safe.dependencies);
    expect(safe.coordinator.prepare).toHaveBeenCalledOnce();
    expect(safe.coordinator.copy).toHaveBeenCalledOnce();
    expect(safe.coordinator.verify).toHaveBeenCalledOnce();
    expect(safe.coordinator.cutover).not.toHaveBeenCalled();
    expect(safe.coordinator.cleanupSource).not.toHaveBeenCalled();
    expect(JSON.parse(safe.lines[0]!).phase).toBe("verified");

    const commit = harness();
    vi.mocked(commit.coordinator.getControl)
      .mockResolvedValueOnce(durableControl({ controlGeneration: 8, phase: "inactive" }))
      .mockResolvedValueOnce(durableControl({ controlGeneration: 9, phase: "committed" }));
    await runBlobStorageMigrationCli(["run"], {
      ...FULL_ENV,
      BLOB_MIGRATION_COMMIT: "1",
    }, commit.dependencies);
    expect(commit.coordinator.cutover).toHaveBeenCalledOnce();
    expect(commit.coordinator.cleanupSource).not.toHaveBeenCalled();
    expect(JSON.parse(commit.lines[0]!).phase).toBe("committed");
  });

  it("converges verified and committed run replays without source cleanup", async () => {
    const verified = harness();
    vi.mocked(verified.coordinator.getControl)
      .mockResolvedValueOnce(durableControl({ controlGeneration: 5, phase: "verified" }))
      .mockResolvedValueOnce(durableControl({ controlGeneration: 5, phase: "verified" }));
    await runBlobStorageMigrationCli(["run"], FULL_ENV, verified.dependencies);
    expect(verified.coordinator.prepare).toHaveBeenCalledOnce();
    expect(verified.coordinator.copy).toHaveBeenCalledOnce();
    expect(verified.coordinator.verify).toHaveBeenCalledOnce();
    expect(verified.coordinator.cutover).not.toHaveBeenCalled();
    expect(verified.coordinator.cleanupSource).not.toHaveBeenCalled();
    expect(JSON.parse(verified.lines[0]!).phase).toBe("verified");

    const committed = harness();
    vi.mocked(committed.coordinator.getControl)
      .mockResolvedValueOnce(durableControl({ controlGeneration: 9, phase: "committed" }))
      .mockResolvedValueOnce(durableControl({ controlGeneration: 9, phase: "committed" }));
    await runBlobStorageMigrationCli(["run"], {
      ...FULL_ENV,
      BLOB_MIGRATION_COMMIT: "1",
    }, committed.dependencies);
    expect(committed.coordinator.prepare).toHaveBeenCalledOnce();
    expect(committed.coordinator.copy).toHaveBeenCalledOnce();
    expect(committed.coordinator.verify).toHaveBeenCalledOnce();
    expect(committed.coordinator.cutover).toHaveBeenCalledOnce();
    expect(committed.coordinator.cleanupSource).not.toHaveBeenCalled();
    expect(JSON.parse(committed.lines[0]!).phase).toBe("committed");
  });

  it("rejects unsafe or incomplete configuration before opening MySQL", async () => {
    const cases: NodeJS.ProcessEnv[] = [
      { ...FULL_ENV, MIGRATION_ID: undefined },
      { ...FULL_ENV, MAX_OBJECT_BYTES: String(1024 * 1024 * 1024 + 1) },
      { ...FULL_ENV, BLOB_S3_ENDPOINT: "http://user:secret@minio.internal:9000/private" },
      { ...FULL_ENV, BLOB_S3_SECRET_ACCESS_KEY: undefined },
      {
        ...FULL_ENV,
        NODE_ENV: "production",
        BLOB_S3_ENDPOINT: "http://minio.internal:9000",
        BLOB_S3_PRIVATE_BUCKET_ACK: "1",
      },
      { ...FULL_ENV, BLOB_MIGRATION_COMMIT: "yes" },
    ];
    for (const env of cases) {
      const h = harness();
      await expect(formattedFailure(
        runBlobStorageMigrationCli(["run"], env, h.dependencies),
      )).resolves.toBe('{"status":"error","code":"invalid_configuration"}');
      expect(h.dependencies.connectCoordinator).not.toHaveBeenCalled();
    }
  });

  it("closes both resources on failure and never exposes raw operational errors", async () => {
    const h = harness();
    vi.mocked(h.coordinator.copy).mockRejectedValueOnce(
      new Error("mysql://user:secret@db/private /private/blob/key"),
    );
    const formatted = await formattedFailure(
      runBlobStorageMigrationCli(["copy"], FULL_ENV, h.dependencies),
    );
    expect(formatted).toBe('{"status":"error","code":"operation_failed"}');
    expect(formatted).not.toContain("secret");
    expect(formatted).not.toContain("private");
    expect(h.coordinator.close).toHaveBeenCalledOnce();
    expect(h.target.close).toHaveBeenCalledOnce();
    expect(h.dependencies.writeLine).not.toHaveBeenCalled();
  });

  it("closes a rejected target probe without opening MySQL", async () => {
    const h = harness();
    h.target.validateStartup.mockRejectedValueOnce(
      new Error("https://access:secret@object-store.internal/private"),
    );
    const formatted = await formattedFailure(
      runBlobStorageMigrationCli(["copy"], FULL_ENV, h.dependencies),
    );
    expect(formatted).toBe('{"status":"error","code":"operation_failed"}');
    expect(h.dependencies.connectCoordinator).not.toHaveBeenCalled();
    expect(h.target.close).toHaveBeenCalledOnce();
    expect(h.dependencies.writeLine).not.toHaveBeenCalled();
  });

  it("fails closed on malformed durable summaries or resource-close failure", async () => {
    const malformed = harness(durableControl({ targetBackend: "https://secret.invalid/path" }));
    await expect(formattedFailure(
      runBlobStorageMigrationCli(
        ["status"],
        { MYSQL_URL: FULL_ENV.MYSQL_URL },
        malformed.dependencies,
      ),
    )).resolves.toBe('{"status":"error","code":"invalid_durable_state"}');
    expect(malformed.coordinator.close).toHaveBeenCalledOnce();
    expect(malformed.dependencies.writeLine).not.toHaveBeenCalled();

    const closeFailure = harness();
    vi.mocked(closeFailure.coordinator.close).mockRejectedValueOnce(
      new Error("mysql://user:secret@db/private"),
    );
    await expect(formattedFailure(
      runBlobStorageMigrationCli(
        ["status"],
        { MYSQL_URL: FULL_ENV.MYSQL_URL },
        closeFailure.dependencies,
      ),
    )).resolves.toBe('{"status":"error","code":"operation_failed"}');
    expect(closeFailure.dependencies.writeLine).not.toHaveBeenCalled();
  });

  it("maps domain failures to a fixed bounded vocabulary without their messages", () => {
    const cases: Array<[unknown, string]> = [
      [new BlobStorageMigrationConflictError("secret conflict"), "migration_conflict"],
      [new BlobStorageMigrationIntegrityError("secret integrity"), "migration_integrity"],
      [new BlobStorageMigrationNotReadyError("secret reason"), "migration_not_ready"],
      [new BlobTooLargeError("private/key", 1, 2), "object_too_large"],
      [new BlobConflictError("private/key"), "storage_conflict"],
      [new Error("mysql://user:secret@db/private"), "operation_failed"],
    ];
    for (const [error, code] of cases) {
      const formatted = formatBlobStorageMigrationCliError(error);
      expect(formatted).toBe(JSON.stringify({ status: "error", code }));
      expect(formatted.length).toBeLessThan(100);
      expect(formatted).not.toContain("secret");
      expect(formatted).not.toContain("private");
    }
  });
});
