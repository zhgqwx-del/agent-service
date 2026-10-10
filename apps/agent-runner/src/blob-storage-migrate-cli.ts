import {
  BLOB_STORAGE_MIGRATION_PHASES,
  BlobConflictError,
  BlobStorageMigrationConflictError,
  BlobStorageMigrationIntegrityError,
  BlobStorageMigrationNotReadyError,
  BlobTooLargeError,
  FsBlobStore,
  MysqlBlobStorageMigrationCoordinator,
  S3BlobStore,
  type BeginBlobStorageMigrationInput,
  type BlobMigrationStore,
  type S3BlobStoreOptions,
} from "@agent-service/store";
import { z } from "zod";

const COMMANDS = [
  "status",
  "prepare",
  "copy",
  "verify",
  "cutover",
  "abort",
  "cleanup-source",
  "run",
] as const;
type BlobStorageMigrationCommand = (typeof COMMANDS)[number];

const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_MAX_OBJECT_BYTES = 1024 * 1024 * 1024;
const MAX_DURATION_MS = Number.MAX_SAFE_INTEGER;
const SHA256 = /^[0-9a-f]{64}$/;
const MIGRATION_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

type CliErrorCode =
  | "invalid_command"
  | "invalid_configuration"
  | "invalid_durable_state"
  | "migration_conflict"
  | "migration_integrity"
  | "migration_not_ready"
  | "object_too_large"
  | "storage_conflict"
  | "operation_failed";

class BlobStorageMigrationCliError extends Error {
  constructor(readonly code: CliErrorCode) {
    super(code);
    this.name = "BlobStorageMigrationCliError";
  }
}

export type BlobStorageMigrationPrepareInput = BeginBlobStorageMigrationInput;

export interface BlobStorageMigrationCliCoordinator {
  close(): Promise<void>;
  getControl(): Promise<unknown>;
  prepare(
    source: BlobMigrationStore,
    target: BlobMigrationStore,
    input: BlobStorageMigrationPrepareInput,
    maxBytes: number,
  ): Promise<unknown>;
  copy(source: BlobMigrationStore, target: BlobMigrationStore, maxBytes: number): Promise<unknown>;
  verify(source: BlobMigrationStore, target: BlobMigrationStore, maxBytes: number): Promise<unknown>;
  cutover(source: BlobMigrationStore, target: BlobMigrationStore, maxBytes: number): Promise<unknown>;
  abort(target: BlobMigrationStore, maxBytes: number): Promise<unknown>;
  cleanupSource(
    source: BlobMigrationStore,
    target: BlobMigrationStore,
    maxBytes: number,
  ): Promise<unknown>;
}

interface MigrationTarget extends BlobMigrationStore {
  validateStartup(): Promise<void>;
  close(): Promise<void>;
}

export interface BlobStorageMigrationCliDependencies {
  connectCoordinator(options: {
    url: string;
    connectionLimit?: number;
    exclusive?: boolean;
  }): Promise<BlobStorageMigrationCliCoordinator>;
  createSource(root: string): BlobMigrationStore;
  createTarget(options: S3BlobStoreOptions): MigrationTarget;
  writeLine(line: string): void;
}

const MysqlEnv = z.object({
  MYSQL_URL: z.string().min(1).max(4_096).refine((value) => {
    if (value.trim() !== value) return false;
    try {
      return new URL(value).protocol === "mysql:";
    } catch {
      return false;
    }
  }),
});

const SourceEnv = z.object({
  BLOB_DIR: z.string().min(1).max(4_096)
    .refine((value) => value.trim() === value && !value.includes("\0")),
});

const TargetEnv = z.object({
  NODE_ENV: z.string().optional(),
  BLOB_NAMESPACE_ID: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  BLOB_S3_ENDPOINT: z.string().min(1).max(2_048).optional(),
  BLOB_S3_REGION: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .default("us-east-1"),
  BLOB_S3_BUCKET: z.string().min(3).max(63),
  BLOB_S3_PREFIX: z.string()
    .regex(/^[a-z0-9_-]{1,128}(?:\/[a-z0-9_-]{1,128})*$/)
    .max(256)
    .default("agent-service-v1"),
  BLOB_S3_FORCE_PATH_STYLE: z.enum(["0", "1"]).default("0"),
  BLOB_S3_PRIVATE_BUCKET_ACK: z.enum(["0", "1"]).default("0"),
  BLOB_S3_REQUEST_TIMEOUT_MS: z.string().optional(),
  BLOB_S3_ACCESS_KEY_ID: z.string().min(1).max(128).optional(),
  BLOB_S3_SECRET_ACCESS_KEY: z.string().min(1).max(512).optional(),
  BLOB_S3_SESSION_TOKEN: z.string().min(1).max(4_096).optional(),
});

const PrepareEnv = z.object({
  MIGRATION_ID: z.string().regex(MIGRATION_ID),
  FLEET_DRAINED_EVIDENCE_SHA256: z.string().regex(SHA256),
  ROLLBACK_WINDOW_MS: z.string(),
  SOURCE_CLEANUP_DELAY_MS: z.string(),
});

function configurationError(): BlobStorageMigrationCliError {
  return new BlobStorageMigrationCliError("invalid_configuration");
}

function parseUnsignedInteger(
  raw: string | undefined,
  min: number,
  max: number,
  fallback?: number,
): number {
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw configurationError();
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw configurationError();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw configurationError();
  return value;
}

function parseCommand(argv: readonly string[]): BlobStorageMigrationCommand {
  if (argv.length !== 1 || !(COMMANDS as readonly string[]).includes(argv[0]!)) {
    throw new BlobStorageMigrationCliError("invalid_command");
  }
  return argv[0] as BlobStorageMigrationCommand;
}

function parseEndpoint(value: string | undefined, production: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() !== value) throw configurationError();
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw configurationError();
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== ""
    || (endpoint.pathname !== "" && endpoint.pathname !== "/")
    || (production && endpoint.protocol !== "https:")
  ) throw configurationError();
  return endpoint.origin;
}

function parseBucket(value: string): string {
  if (
    !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(value)
    || value.includes("..")
    || value.includes(".-")
    || value.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  ) throw configurationError();
  return value;
}

function sourceFromEnv(
  env: NodeJS.ProcessEnv,
  dependencies: BlobStorageMigrationCliDependencies,
): BlobMigrationStore {
  const config = SourceEnv.parse(env);
  return dependencies.createSource(config.BLOB_DIR);
}

function targetFromEnv(
  env: NodeJS.ProcessEnv,
  dependencies: BlobStorageMigrationCliDependencies,
): MigrationTarget {
  const config = TargetEnv.parse(env);
  const production = config.NODE_ENV === "production";
  if (
    (config.BLOB_S3_ACCESS_KEY_ID === undefined)
      !== (config.BLOB_S3_SECRET_ACCESS_KEY === undefined)
    || (config.BLOB_S3_SESSION_TOKEN !== undefined
      && config.BLOB_S3_ACCESS_KEY_ID === undefined)
    || (production && config.BLOB_S3_PRIVATE_BUCKET_ACK !== "1")
  ) throw configurationError();

  const endpoint = parseEndpoint(config.BLOB_S3_ENDPOINT, production);
  const requestTimeoutMs = parseUnsignedInteger(
    config.BLOB_S3_REQUEST_TIMEOUT_MS,
    100,
    30_000,
    5_000,
  );
  return dependencies.createTarget({
    bucket: parseBucket(config.BLOB_S3_BUCKET),
    namespaceId: config.BLOB_NAMESPACE_ID,
    prefix: config.BLOB_S3_PREFIX,
    requestTimeoutMs,
    clientConfig: {
      region: config.BLOB_S3_REGION,
      forcePathStyle: config.BLOB_S3_FORCE_PATH_STYLE === "1",
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(config.BLOB_S3_ACCESS_KEY_ID === undefined
        ? {}
        : {
            credentials: {
              accessKeyId: config.BLOB_S3_ACCESS_KEY_ID,
              secretAccessKey: config.BLOB_S3_SECRET_ACCESS_KEY!,
              ...(config.BLOB_S3_SESSION_TOKEN === undefined
                ? {}
                : { sessionToken: config.BLOB_S3_SESSION_TOKEN }),
            },
          }),
    },
  });
}

function maxObjectBytesFromEnv(env: NodeJS.ProcessEnv): number {
  return parseUnsignedInteger(
    env.MAX_OBJECT_BYTES,
    1,
    MAX_MAX_OBJECT_BYTES,
    DEFAULT_MAX_OBJECT_BYTES,
  );
}

function controlGeneration(control: unknown): number {
  if (!control || typeof control !== "object") {
    throw new BlobStorageMigrationCliError("invalid_durable_state");
  }
  const generation = (control as { controlGeneration?: unknown }).controlGeneration;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    throw new BlobStorageMigrationCliError("invalid_durable_state");
  }
  return generation as number;
}

function prepareSettingsFromEnv(env: NodeJS.ProcessEnv): Pick<
  BlobStorageMigrationPrepareInput,
  | "migrationId"
  | "fleetDrainedEvidenceSha256"
  | "rollbackWindowMs"
  | "sourceCleanupDelayMs"
> {
  const config = PrepareEnv.parse(env);
  return {
    migrationId: config.MIGRATION_ID,
    fleetDrainedEvidenceSha256: config.FLEET_DRAINED_EVIDENCE_SHA256,
    rollbackWindowMs: parseUnsignedInteger(
      config.ROLLBACK_WINDOW_MS,
      0,
      MAX_DURATION_MS,
    ),
    sourceCleanupDelayMs: parseUnsignedInteger(
      config.SOURCE_CLEANUP_DELAY_MS,
      0,
      MAX_DURATION_MS,
    ),
  };
}

function prepareInput(
  settings: Omit<BlobStorageMigrationPrepareInput, "expectedControlGeneration">,
  expectedControlGeneration: number,
): BlobStorageMigrationPrepareInput {
  return { ...settings, expectedControlGeneration };
}

function migrationIdentities(
  source: BlobMigrationStore,
  target: BlobMigrationStore,
): Pick<
  BlobStorageMigrationPrepareInput,
  "sourceBackend" | "sourceNamespaceSha256" | "targetBackend" | "targetNamespaceSha256"
> {
  if (
    source.backend !== "filesystem-v1"
    || typeof source.namespaceSha256 !== "string"
    || !SHA256.test(source.namespaceSha256)
    || typeof target.namespaceSha256 !== "string"
    || !SHA256.test(target.namespaceSha256)
    || target.backend !== `s3-v1-${target.namespaceSha256.slice(0, 24)}`
  ) throw configurationError();
  return {
    sourceBackend: "filesystem-v1",
    sourceNamespaceSha256: source.namespaceSha256,
    targetBackend: target.backend,
    targetNamespaceSha256: target.namespaceSha256,
  };
}

function backendSummary(value: unknown): "filesystem-v1" | "s3-v1" | "unconfigured" {
  if (value === undefined) return "unconfigured";
  if (value === "filesystem-v1") return value;
  if (typeof value === "string" && /^s3-v1-[0-9a-f]{24}$/.test(value)) return "s3-v1";
  throw new BlobStorageMigrationCliError("invalid_durable_state");
}

function countField(control: Record<string, unknown>, key: string): number {
  const value = control[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BlobStorageMigrationCliError("invalid_durable_state");
  }
  return value as number;
}

function outputSummary(command: BlobStorageMigrationCommand, value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new BlobStorageMigrationCliError("invalid_durable_state");
  }
  const control = value as Record<string, unknown>;
  const phase = control.phase;
  if (typeof phase !== "string" || !(BLOB_STORAGE_MIGRATION_PHASES as readonly string[]).includes(phase)) {
    throw new BlobStorageMigrationCliError("invalid_durable_state");
  }
  return JSON.stringify({
    status: "ok",
    command,
    phase,
    controlGeneration: controlGeneration(control),
    inventoryEntryCount: countField(control, "inventoryEntryCount"),
    objectAckCount: countField(control, "objectAckCount"),
    sourceBackend: backendSummary(control.sourceBackend),
    targetBackend: backendSummary(control.targetBackend),
  });
}

function commitRunFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.BLOB_MIGRATION_COMMIT ?? "0";
  if (value !== "0" && value !== "1") throw configurationError();
  return value === "1";
}

async function defaultConnectCoordinator(options: {
  url: string;
  connectionLimit?: number;
  exclusive?: boolean;
}): Promise<BlobStorageMigrationCliCoordinator> {
  return MysqlBlobStorageMigrationCoordinator.connect(options);
}

const DEFAULT_DEPENDENCIES: BlobStorageMigrationCliDependencies = {
  connectCoordinator: defaultConnectCoordinator,
  createSource: (root) => new FsBlobStore(root),
  createTarget: (options) => new S3BlobStore(options),
  writeLine: (line) => process.stdout.write(`${line}\n`),
};

function closeSafely(resource: { close(): Promise<void> } | undefined): Promise<void> | undefined {
  return resource === undefined
    ? undefined
    : Promise.resolve().then(() => resource.close());
}

export async function runBlobStorageMigrationCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: BlobStorageMigrationCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const command = parseCommand(argv);
  const mysql = MysqlEnv.parse(env);
  const maxBytes = command === "status" ? undefined : maxObjectBytesFromEnv(env);
  const shouldCommitRun = command === "run" ? commitRunFromEnv(env) : false;
  const prepareConfig = command === "prepare" || command === "run"
    ? prepareSettingsFromEnv(env)
    : undefined;

  // Parse and construct every command-specific adapter before opening MySQL. Invalid local config
  // therefore cannot acquire a durable migration coordinator or partially advance its state.
  const source = ["prepare", "copy", "verify", "cutover", "cleanup-source", "run"].includes(command)
    ? sourceFromEnv(env, dependencies)
    : undefined;
  const target = [
    "prepare",
    "copy",
    "verify",
    "cutover",
    "abort",
    "cleanup-source",
    "run",
  ].includes(command)
    ? targetFromEnv(env, dependencies)
    : undefined;
  const prepareIdentity = prepareConfig === undefined
    ? undefined
    : migrationIdentities(source!, target!);

  let coordinator: BlobStorageMigrationCliCoordinator | undefined;
  let operationError: unknown;
  let summary: string | undefined;
  try {
    if (target) await target.validateStartup();
    coordinator = await dependencies.connectCoordinator({
      url: mysql.MYSQL_URL,
      connectionLimit: command === "status" ? 1 : 2,
      exclusive: command !== "status",
    });

    if (command === "status") {
      // No Blob adapter is created for status: it is a content-free durable control read.
    } else if (command === "prepare") {
      const current = await coordinator.getControl();
      await coordinator.prepare(
        source!,
        target!,
        prepareInput({
          ...prepareConfig!,
          ...prepareIdentity!,
        }, controlGeneration(current)),
        maxBytes!,
      );
    } else if (command === "copy") {
      await coordinator.copy(source!, target!, maxBytes!);
    } else if (command === "verify") {
      await coordinator.verify(source!, target!, maxBytes!);
    } else if (command === "cutover") {
      await coordinator.cutover(source!, target!, maxBytes!);
    } else if (command === "abort") {
      await coordinator.abort(target!, maxBytes!);
    } else if (command === "cleanup-source") {
      await coordinator.cleanupSource(source!, target!, maxBytes!);
    } else {
      const current = await coordinator.getControl();
      await coordinator.prepare(
        source!,
        target!,
        prepareInput({
          ...prepareConfig!,
          ...prepareIdentity!,
        }, controlGeneration(current)),
        maxBytes!,
      );
      await coordinator.copy(source!, target!, maxBytes!);
      await coordinator.verify(source!, target!, maxBytes!);
      if (shouldCommitRun) {
        await coordinator.cutover(source!, target!, maxBytes!);
        // Source retention is a separate irreversible boundary. Even when its delay is zero, an
        // operator must observe the committed cutover and invoke cleanup-source explicitly.
      }
    }

    summary = outputSummary(command, await coordinator.getControl());
  } catch (error) {
    operationError = error;
  }

  const closeResults = await Promise.allSettled([
    closeSafely(coordinator),
    closeSafely(target),
  ].filter((operation): operation is Promise<void> => operation !== undefined));
  if (operationError !== undefined) throw operationError;
  if (closeResults.some((result) => result.status === "rejected")) {
    throw new BlobStorageMigrationCliError("operation_failed");
  }
  if (summary === undefined) throw new BlobStorageMigrationCliError("operation_failed");
  dependencies.writeLine(summary);
  return 0;
}

function errorCode(error: unknown): CliErrorCode {
  if (error instanceof BlobStorageMigrationCliError) return error.code;
  if (error instanceof z.ZodError) return "invalid_configuration";
  if (error instanceof BlobStorageMigrationConflictError) return "migration_conflict";
  if (error instanceof BlobStorageMigrationIntegrityError) return "migration_integrity";
  if (error instanceof BlobStorageMigrationNotReadyError) return "migration_not_ready";
  if (error instanceof BlobTooLargeError) return "object_too_large";
  if (error instanceof BlobConflictError) return "storage_conflict";
  return "operation_failed";
}

export function formatBlobStorageMigrationCliError(error: unknown): string {
  return JSON.stringify({ status: "error", code: errorCode(error) });
}
