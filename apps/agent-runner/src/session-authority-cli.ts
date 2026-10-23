import { MysqlSessionStore, captureSessionAuthorityBindingCommand,
  type SessionAuthorityBindingOperatorContext } from "@agent-service/store";
import { loadSessionAuthorityOperatorContext, parseSessionAuthorityOperatorConfiguration } from "./session-authority-operator-config.js";
import { readTelemetryCaptureRefKey, tenantTelemetryOperatorRefKeyPath } from "./telemetry-capture-ref-key.js";

// UNAPPLIED strict foreground mode in the existing main.js, never ordinary startup.
const HELP = `Usage: agent-runner authority <preflight|activate>

preflight  Verify native target/source/account/connection admission without activating.
activate   Install only the initial fixed binding after successful native admission.

Environment-only authority (no argv URL, credentials, JSON or SQL):
  AUTHORITY_MYSQL_URL                 Explicit operator mysql:// URL; no MYSQL_URL fallback.
  AUTHORITY_COMMAND_FILE              Owned0600 JSON in an owned0700 canonical directory.
  AUTHORITY_METADATA_SCHEMA           Explicit existing metadata schema.
  AUTHORITY_METADATA_DEFINER_USER     Exact pre-provisioned locked metadata principal.
  AUTHORITY_METADATA_DEFINER_HOST     Exact authenticated account host pattern.
  AUTHORITY_FLEET_STOPPED_ACK         all-application-writers-stopped-v1
  AUTHORITY_EXCLUSIVE_CHANGE_ACK      exclusive-authority-permissions-window-v1
  AUTHORITY_OPERATION_TIMEOUT_MS      1000..120000; default120000.
  TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE  Optional protected raw32-byte file; required for active0033.

Application TENANT_TELEMETRY_REF_KEY (including empty) is rejected. No argv/env key material.

ACKs declare the exclusive deployment window. Native admission still checks actual rights,
roles/proxies, connections and transactions. No GRANT, KILL, DDL or automatic service start.
The fixed JSON includes expectedSource and stable binding/activation IDs; preserve it after
unknown results and retry exactly. Never refresh the epoch or invent a new command to hide unknown.
Restore successors run only in the existing controlled restore activation transaction.
Cancellation stops admission and awaits actual owned work/transport closure, not a hard exit.
`;
interface AuthorityMaintenance {
  preflightSessionAuthorityBinding(): Promise<void>;
  initializeSessionAuthorityBinding(): Promise<void>;
  confirmSessionAuthorityBinding(): Promise<void>;
  close(): Promise<void>;
}
export interface SessionAuthorityCliDependencies {
  connect(url: string, signal: AbortSignal, context: SessionAuthorityBindingOperatorContext,
    tenantTelemetryRefKey?: Uint8Array): Promise<AuthorityMaintenance>;
  readRefKey?: (path: string) => Promise<Buffer>;
  writeLine(line: string): void; writeError(line: string): void;
  installInterrupts(stop: () => void): () => void;
}
const DEFAULTS: SessionAuthorityCliDependencies = {
  connect: (url, operationAbortSignal, binding, tenantTelemetryRefKey) => MysqlSessionStore.connectRestoreJournalMaintenance(
    { url, connectionLimit: 1, operationAbortSignal,
      ...(tenantTelemetryRefKey === undefined ? {} : { tenantTelemetryRefKey }) },
    { kind: "operator-maintenance", binding }),
  writeLine: line => { process.stdout.write(line + "\n"); },
  writeError: line => { process.stderr.write(line + "\n"); },
  installInterrupts(stop) {
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    return () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); };
  },
};
type Code = "invalid_arguments" | "invalid_configuration" | "operation_failed" | "operation_deadline" | "operation_cancelled";
function failed(deps: SessionAuthorityCliDependencies, code: Code): 1 {
  try { deps.writeError(JSON.stringify({ status: "error", code })); } catch { /* Never use output as authority. */ }
  return 1;
}
export async function runSessionAuthorityCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env,
  deps: SessionAuthorityCliDependencies = DEFAULTS): Promise<0 | 1> {
  if (argv.length !== 2 || argv[0] !== "authority") return failed(deps, "invalid_arguments");
  if (argv[1] === "--help" || argv[1] === "-h") {
    try { deps.writeLine(HELP); return 0; } catch { return failed(deps, "operation_failed"); }
  }
  if (argv[1] !== "preflight" && argv[1] !== "activate") return failed(deps, "invalid_arguments");
  let config: ReturnType<typeof parseSessionAuthorityOperatorConfiguration>, refKeyPath: string | undefined;
  try {
    config = parseSessionAuthorityOperatorConfiguration(env);
    refKeyPath = tenantTelemetryOperatorRefKeyPath(env);
  } catch { return failed(deps, "invalid_configuration"); }
  const controller = new AbortController();
  let timedOut = false, interrupted = false, remove: (() => void) | undefined;
  let store: AuthorityMaintenance | undefined, refKey: Buffer | undefined;
  let firstError: unknown, hasError = false, summary: string | undefined;
  const remember = (error: unknown) => { if (!hasError) firstError = error; hasError = true; };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
  try {
    remove = deps.installInterrupts(() => { interrupted = true; controller.abort(); });
    const context = await loadSessionAuthorityOperatorContext(config, controller.signal);
    const command = captureSessionAuthorityBindingCommand(context.command);
    if (command.expectedBindingId !== null || command.expectedSequence !== 0 || command.nextEpoch !== null) {
      throw Error("invalid_configuration"); // Successors must stay in their original restore TX.
    }
    controller.signal.throwIfAborted();
    if (refKeyPath !== undefined) {
      refKey = await (deps.readRefKey ?? readTelemetryCaptureRefKey)(refKeyPath);
      if (!Buffer.isBuffer(refKey) || refKey.length !== 32) throw Error("invalid_configuration");
      controller.signal.throwIfAborted();
    }
    store = await deps.connect(config.url, controller.signal, context, refKey);
    controller.signal.throwIfAborted();
    if (argv[1] === "preflight") await store.preflightSessionAuthorityBinding();
    else {
      await store.initializeSessionAuthorityBinding();
      await store.confirmSessionAuthorityBinding();
    }
    controller.signal.throwIfAborted();
    summary = JSON.stringify({ status: "ok", command: argv[1], activated: argv[1] === "activate", commandSha256: command.commandSha256 });
  } catch (error) { remember(error); }
  try { await store?.close(); } catch (error) { remember(error); }
  finally {
    // The original read/connect/work/close promises have settled before releasing key material.
    try { refKey?.fill(0); } catch (error) { remember(error); }
    clearTimeout(timer);
    try { remove?.(); } catch (error) { remember(error); }
  }
  if (hasError || !summary || controller.signal.aborted) {
    return failed(deps, timedOut ? "operation_deadline" : interrupted ? "operation_cancelled"
      : firstError instanceof Error && firstError.message === "invalid_configuration" ? "invalid_configuration" : "operation_failed");
  }
  try { deps.writeLine(summary); return 0; } catch { return failed(deps, "operation_failed"); }
}
