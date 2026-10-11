const HELP = `Usage: backup-catalog <command>

Operate the authoritative, content-free backup catalog from the agent-runner image. This is an
offline one-shot command; it never starts a daemon and it is not an Agent Runtime API endpoint.

Commands:
  status             Read catalog control, external head and projected recoverable counts.
  activate           One-way activation after the restore journal and Blob control are active.
  begin-backup       Anchor the current database/runtime lineage before a full backup is taken.
  publish-backup     Bind operator-attested artifact evidence and publish one recoverable full backup.
  list               List recoverable backup identities; never prints locators or credentials.
  prepare-restore    Select one exact backup and reserve a permanently unique runtime epoch.
  resolve-restore    Project an externally confirmed activated/aborted restore reservation.
  prepare-eviction   Produce a retention-checked, catalog-head-bound eviction plan.
  record-eviction    Record physical absence and its immutable external tombstone.
  reconcile          Replay and validate a sealed external catalog event chain into MySQL.

Database, object-store, backup, restore and evidence settings are accepted only through environment
variables. Command-line flags cannot carry a DSN, endpoint, locator, path, header or credential.

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

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().then(
    (status) => { process.exitCode = status; },
    () => {
      console.error("backup-catalog failed (internal_error)");
      process.exitCode = 1;
    },
  );
}
