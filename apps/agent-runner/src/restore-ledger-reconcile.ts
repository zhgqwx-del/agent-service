const HELP = `Usage: restore-ledger-reconcile <command>

Reconcile the independent tenant restore journal before an agent-runner may serve a restored or
rolled-back database. This is an offline, one-shot command packaged in the agent-runner image.

Commands:
  status            Read content-free journal and runtime-control status.
  activate-journal  One-way primary activation; every configured target must be exactly empty.
  prepare           Seal every configured external journal head for one restore run.
  replay-fences     Replay the sealed records into permanent local tenant fences.
  verify            Seal the complete replay evidence after every record is accounted for.
  activate-runtime  Commit the new runtime epoch after verified replay.
  abort             Abort a prepared, not-yet-active restore run.
  run               Prepare, replay, and verify; activation remains an explicit command.

Database, object-store, restore-run, backup and epoch settings are accepted only through
environment variables. Command-line flags cannot carry a DSN, endpoint, path or credential.

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

  let command: typeof import("./restore-ledger-reconcile-cli.js");
  try {
    // Keep --help resource-free and safe to execute in an image build check.
    command = await import("./restore-ledger-reconcile-cli.js");
  } catch {
    console.error("restore-ledger-reconcile failed (command_unavailable)");
    return 1;
  }

  try {
    const status = await command.runRestoreLedgerReconcileCli(commandArgv, env);
    if (status === undefined) return 0;
    if (!Number.isInteger(status) || status < 0 || status > 255) {
      console.error("restore-ledger-reconcile failed (invalid_exit_status)");
      return 1;
    }
    return status;
  } catch (error) {
    try {
      console.error(command.formatRestoreLedgerReconcileCliError(error));
    } catch {
      console.error("restore-ledger-reconcile failed (internal_error)");
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().then(
    (status) => { process.exitCode = status; },
    () => {
      console.error("restore-ledger-reconcile failed (internal_error)");
      process.exitCode = 1;
    },
  );
}
