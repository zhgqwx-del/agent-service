import { isDirectCliEntrypoint } from "./cli-entrypoint.js";

const HELP = `Usage: backup-catalog <command>

Operate the authoritative, content-free backup catalog from the agent-runner bundle. This is an
offline one-shot command; it never starts a daemon and it is not an Agent Runtime API endpoint.

Commands:
  status             Read catalog control, external head and projected recoverable counts.
  activate           One-way activation after the restore journal and Blob control are active.
  begin-backup       Anchor the current database/runtime lineage before a full backup is taken.
  publish-backup     Bind operator-attested artifact evidence and publish one recoverable full backup.
  create-artifact    Local-only: dump, encrypt, authenticate and publish an actual MySQL artifact.
  verify-artifact    Local-only: authenticate artifact bytes against fresh recoverable catalog evidence.
  restore-selected   Local-only: import authenticated bytes into an isolated empty database; leave prepared.
  replay-selected    Local-only: authenticate the same v2 artifact and replay the selected run's fences.
  verify-selected    Local-only: explicitly seal and verify the selected run's replay receipt.
  activate-selected  Local-only: explicitly activate the selected runtime and its read-only capture history.
  activate-capture-selected  Local-only: independently authorize capture in that exact restored epoch.
  resolve-selected   Local-only: explicitly resolve that authenticated v2 run's active reservation as activated.
  list               List recoverable backup identities; never prints locators or credentials.
  prepare-restore    Select one exact backup and reserve a permanently unique runtime epoch.
  resolve-restore    Project an externally confirmed activated/aborted restore reservation.
  prepare-eviction   Produce a retention-checked, catalog-head-bound eviction plan.
  record-eviction    Record physical absence and its immutable external tombstone.
  reconcile          Replay and validate a sealed external catalog event chain into MySQL.

Database, object-store, backup, restore and evidence settings are accepted only through environment
variables. Command-line flags cannot carry a DSN, endpoint, locator, path, header or credential.
For an active telemetry lifecycle database, set TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE to the
same protected owner-only regular file containing exactly 32 raw bytes (not hex) on source and
restored target. Inactive databases may omit it. Missing/wrong keys fail closed during verify-only
startup audit. Direct commands reject any ambient TENANT_TELEMETRY_REF_KEY, including empty;
local-service.sh clears that application hex input for the foreground command only.

Artifact creation, verification, initial restore and selected continuation commands require
BACKUP_ARTIFACT_LOCAL_ONLY_ACK=1, a private
BACKUP_ARTIFACT_DIRECTORY and an independent, private 32-byte BACKUP_ARTIFACT_KEY_FILE.
Create/restore additionally require RESTORE_FLEET_STOPPED_ACK=1 and explicitly trusted absolute
BACKUP_MYSQL_BINARY/BACKUP_MYSQLDUMP_BINARY paths. Install MySQL 8 mysql/mysqldump externally:
the current runner image does not include these tools. Production use is rejected.
Only loopback MySQL database URLs are supported by this local artifact slice.
RESTORE_FLEET_STOPPED_ACK is an operator declaration, not proof that every writer has stopped.

restore-selected requires BACKUP_RESTORE_TARGET_MYSQL_URL plus the same BACKUP_ID,
RESTORE_RUN_ID and BACKUP_RUNTIME_EPOCH_ID throughout the operation. The target must already
exist, be empty and have a different actual server/database identity tuple from the source.
It never clears a target, starts services, replays restore fences or activates a runtime.
Interrupted DDL import may leave an isolated partial target and permanently consumed reservation;
nonempty retries are refused. restore-selected is first-attempt-only: any previously reserved run
or epoch is permanently refused, even with another artifact directory or empty target.
Preserve exact operation evidence for explicit manual forward-fix
with prepare-restore and restore-ledger-reconcile. Source loss and automatic import resume are unsupported.
publish-backup remains attestation-only and does not produce or authenticate artifact bytes.
For active provider capture, the five selected continuation commands authenticate the same
v2 artifact, the existing target's exact binding/reservation, external authority and history.
They never import again or reserve a new epoch. replay-selected requires BACKUP_RESTORE_REPLAY_ACK=1;
verify-selected requires BACKUP_RESTORE_VERIFY_ACK=1; activate-selected independently requires
BACKUP_RESTORE_RUNTIME_ACTIVATION_ACK=1. All require RESTORE_FLEET_STOPPED_ACK=1 and the protected
operator ref key. Ordinary startup remains fail closed before the separate capture cutover.
activate-capture-selected additionally requires TELEMETRY_CAPTURE_RESTORED_EPOCH_ACTIVATION_ACK=1,
the four TELEMETRY_CAPTURE_LOCAL_ONLY/FLEET_STOPPED/LEGACY_WRITERS_DRAINED/PRODUCER_READY_ACK=1
declarations and TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256. History alone never grants writes.
Catalog resolution stays explicit.
resolve-selected separately requires BACKUP_RESTORE_CATALOG_RESOLUTION_ACK=1. It authenticates
the full external catalog chain, already active exact target run and committed capture cutover before its external CAS
and local projection; it never activates runtime/capture or grants ordinary writer authority.
Response loss requires an explicit retry with exactly the same artifact/run/epoch identities.
Legacy resolve-restore is unchanged; selected v2 resolution uses resolve-selected, never a fallback.
No command claims all-domain completion.

Options:
  -h, --help  Show this help and exit.
`;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const commandArgv = argv[0] === "--" ? argv.slice(1) : argv;
  if (commandArgv.length === 1 && (commandArgv[0] === "--help" || commandArgv[0] === "-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  let command: typeof import("./backup-catalog-cli.js");
  try {
    // Keep --help resource-free and safe to execute in build/image checks.
    command = await import("./backup-catalog-cli.js");
  } catch {
    console.error("backup-catalog failed (command_unavailable)");
    return 1;
  }

  try {
    const status = await command.runBackupCatalogCli(commandArgv, env);
    if (status === undefined) return 0;
    if (!Number.isInteger(status) || status < 0 || status > 255) {
      console.error("backup-catalog failed (invalid_exit_status)");
      return 1;
    }
    return status;
  } catch (error) {
    try {
      console.error(command.formatBackupCatalogCliError(error));
    } catch {
      console.error("backup-catalog failed (internal_error)");
    }
    return 1;
  }
}

if (isDirectCliEntrypoint(import.meta.url)) {
  main().then(
    (status) => { process.exitCode = status; },
    () => {
      console.error("backup-catalog failed (internal_error)");
      process.exitCode = 1;
    },
  );
}
