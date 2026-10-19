import type { MysqlSchemaOperationOptions } from "@agent-service/store";

const STOPPED_ACK = "all-application-writers-stopped-v1" as const;
const HELP = `Usage: agent-runner schema <command>

Commands:
  migrate  Apply the packaged schema after every application writer has stopped.
  verify   Verify the packaged schema without applying migrations.
  install-metadata  Install or exactly verify the fixed metadata procedure after writers stop.

Configuration is environment-only:
  SCHEMA_MYSQL_URL                         Explicit mysql:// URL with a database; no fallback.
  SCHEMA_FLEET_STOPPED_ACK                 Required by migrate/install-metadata: all-application-writers-stopped-v1.
  SCHEMA_OPERATION_TIMEOUT_MS              1000..120000; default 120000.
  SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS    0..60; default 30; cannot exceed the operation budget.
  SCHEMA_METADATA_SCHEMA                  Required only by install-metadata: existing metadata schema.
  SCHEMA_METADATA_DEFINER_USER            Required only by install-metadata: pre-provisioned locked account.
  SCHEMA_METADATA_DEFINER_HOST            Required only by install-metadata: exact account host.

The stopped-fleet ACK is an operator declaration, not automatic proof of drain.
This command never creates a database, starts a service or activates runtime controls.
DDL may already have committed when a connection is lost or the operation is cancelled.
Preserve the target and evidence; this command never automatically retries a failed operation.
No DSN, credential, path, SQL or migration-directory override is accepted as an argument.
Metadata schema, locked account and grants must be explicitly pre-provisioned by the operator.
Installation never CREATEs a database/user, GRANTs privileges, DROP/replaces drift, or CALLs the procedure.
After installation the operator must grant exact procedure EXECUTE to both the definer itself and runtime.
Metadata configuration is rejected for migrate/verify; no automatic installation or privilege fallback.

Options:
  schema -h, schema --help  Show this help without opening resources.
`;

export interface SchemaCliDependencies {
  /** Resolves or rejects only after the Store's native work and owned resources have settled. */
  runSchemaOperation(options: MysqlSchemaOperationOptions): Promise<void>;
  writeLine(line: string): void;
  writeError(line: string): void;
  /** Owned one-shot signal handlers; the returned function removes only these handlers. */
  installInterrupts(interrupt: () => void): () => void;
}

const DEFAULT_DEPENDENCIES: SchemaCliDependencies = {
  runSchemaOperation: async (options) => {
    // This module requests database work only for an admitted schema operation, not for help.
    // The containing main bundle may already have statically imported the Store implementation.
    const { MysqlSessionStore } = await import("@agent-service/store");
    await MysqlSessionStore.runSchemaOperation(options);
  },
  writeLine: (line) => { process.stdout.write(`${line}\n`); },
  writeError: (line) => { process.stderr.write(`${line}\n`); },
  installInterrupts: (interrupt) => {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    return () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    };
  },
};

type SchemaCommand = "migrate" | "verify" | "install-metadata";
type SchemaMetadataConfig = NonNullable<MysqlSchemaOperationOptions["schemaMetadata"]>;
type FailureCode = "invalid_arguments" | "invalid_configuration" | "operation_deadline"
  | "operation_cancelled" | "operation_failed";

function failed(dependencies: SchemaCliDependencies, code: FailureCode): 1 {
  // Never serialize native errors, URLs, SQL, environment values or causes.
  try { dependencies.writeError(JSON.stringify({ status: "error", code })); } catch { /* output is not authority */ }
  return 1;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function mysqlUrl(value: string | undefined): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096
    || value.trim() !== value || !value.startsWith("mysql://") || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "mysql:" || !parsed.hostname || parsed.search !== "" || parsed.hash !== ""
      || value.includes("?") || value.includes("#")
      || !/^\/[^/]+$/.test(parsed.pathname)) return false;
    const database = decodeURIComponent(parsed.pathname.slice(1));
    return database.length > 0 && database.length <= 64 && database.trim() === database
      && !/[\\/\u0000-\u001f\u007f]/.test(database);
  } catch { return false; }
}

const METADATA_ENV_KEYS = ["SCHEMA_METADATA_SCHEMA", "SCHEMA_METADATA_DEFINER_USER", "SCHEMA_METADATA_DEFINER_HOST"] as const;
function accountPart(value: unknown, maxCharacters: number): value is string {
  return typeof value === "string" && [...value].length >= 1 && [...value].length <= maxCharacters
    && Buffer.byteLength(value, "utf8") <= maxCharacters * 4 && Buffer.from(value, "utf8").toString("utf8") === value
    && !/[\u0000-\u001f\u007f@]/.test(value);
}
/** Parser-local validation only; Store independently captures the same closed authority shape. */
function metadataConfiguration(env: NodeJS.ProcessEnv, command: SchemaCommand): SchemaMetadataConfig | undefined | null {
  const keys = Reflect.ownKeys(env).filter((key): key is string => typeof key === "string" && key.startsWith("SCHEMA_METADATA_"));
  if (command !== "install-metadata") return keys.length === 0 ? undefined : null;
  if (keys.length !== METADATA_ENV_KEYS.length || keys.some(key => !METADATA_ENV_KEYS.some(allowed => key === allowed))) return null;
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of METADATA_ENV_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    captured[key] = descriptor.value;
  }
  const schema = captured.SCHEMA_METADATA_SCHEMA, user = captured.SCHEMA_METADATA_DEFINER_USER, host = captured.SCHEMA_METADATA_DEFINER_HOST;
  if (typeof schema !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(schema)
    || !accountPart(user, 32) || !accountPart(host, 255)) return null;
  return Object.freeze({ metadataSchema: schema, trustedDefiner: Object.freeze({ user, host }) });
}

/**
 * Full main.js argv, including the exact `schema` discriminator. No empty/unknown argv can
 * accidentally become ordinary startup here. Importing this module performs no command work.
 */
export async function runSchemaCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: SchemaCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<0 | 1> {
  if (argv.length !== 2 || argv[0] !== "schema") return failed(dependencies, "invalid_arguments");
  if (argv[1] === "--help" || argv[1] === "-h") {
    try { dependencies.writeLine(HELP); return 0; }
    catch { return failed(dependencies, "operation_failed"); }
  }
  if (argv[1] !== "migrate" && argv[1] !== "verify" && argv[1] !== "install-metadata") return failed(dependencies, "invalid_arguments");
  const command: SchemaCommand = argv[1];
  let url: string | undefined;
  let timeoutMs: number | null;
  let lockSeconds: number | null;
  let schemaMetadata: SchemaMetadataConfig | undefined | null;
  try {
    url = env.SCHEMA_MYSQL_URL;
    timeoutMs = integer(env.SCHEMA_OPERATION_TIMEOUT_MS, 120_000, 1000, 120_000);
    lockSeconds = integer(env.SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS, 30, 0, 60);
    schemaMetadata = metadataConfiguration(env, command);
    if (!mysqlUrl(url) || timeoutMs === null || lockSeconds === null
      || schemaMetadata === null
      || lockSeconds * 1000 > timeoutMs
      || command !== "verify" && env.SCHEMA_FLEET_STOPPED_ACK !== STOPPED_ACK) {
      return failed(dependencies, "invalid_configuration");
    }
  } catch {
    return failed(dependencies, "invalid_configuration");
  }

  const controller = new AbortController();
  let timedOut = false;
  let interrupted = false;
  let removeInterrupts: (() => void) | undefined;
  // Keep this timer referenced: a pending connection must not make this foreground command exit
  // before its cancellation and native settlement barrier have run.
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let success = false;
  try {
    removeInterrupts = dependencies.installInterrupts(() => { interrupted = true; controller.abort(); });
    if (!controller.signal.aborted) {
      await dependencies.runSchemaOperation({
        url,
        operation: command,
        operationAbortSignal: controller.signal,
        migrationLockTimeoutSeconds: lockSeconds,
        ...(command !== "verify" ? { fleetStoppedAck: STOPPED_ACK } : {}),
        ...(schemaMetadata === undefined ? {} : { schemaMetadata }),
      });
    }
    // No Promise.race: even timeout or SIGTERM waits for the real Store operation to settle.
    success = !controller.signal.aborted;
  } catch {
    success = false;
  } finally {
    clearTimeout(timer);
    try { removeInterrupts?.(); } catch { success = false; }
  }
  if (!success) return failed(dependencies, timedOut ? "operation_deadline"
    : interrupted ? "operation_cancelled" : "operation_failed");
  try {
    dependencies.writeLine(JSON.stringify({ status: "ok", command }));
    return 0;
  } catch { return failed(dependencies, "operation_failed"); }
}
