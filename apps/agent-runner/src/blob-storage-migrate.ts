const HELP = `Usage: blob-storage-migrate [options]

Run the audited, one-shot filesystem-to-S3 Blob migration packaged with agent-runner.
Configuration and migration options are validated by the command before it touches either store.

Commands:
  status          Read the durable migration control without opening either Blob store.
  prepare         Freeze writes and seal the filesystem inventory.
  copy            Copy or reconcile the sealed objects into S3.
  verify          Re-read both stores and seal the copy evidence.
  cutover         Commit the verified S3 namespace after the rollback window.
  abort           Fence only migration-owned, uncommitted S3 targets.
  cleanup-source  Revalidate S3, then remove filesystem bytes after cleanup eligibility.
  run             Prepare, copy, and verify; cut over only with BLOB_MIGRATION_COMMIT=1.

All database, filesystem, S3, identity, delay, and size settings are accepted only through
environment variables. Command-line flags cannot carry a DSN, path, endpoint, or credential.

Options:
  -h, --help  Show this help and exit.
`;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  // `pnpm run <script> -- ...` preserves its separator with current pnpm releases.
  const commandArgv = argv[0] === "--" ? argv.slice(1) : argv;
  if (commandArgv.length === 1 && (commandArgv[0] === "--help" || commandArgv[0] === "-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  let command: typeof import("./blob-storage-migrate-cli.js");
  try {
    // Keep --help resource-free: loading the business module is deferred until an actual run.
    command = await import("./blob-storage-migrate-cli.js");
  } catch {
    console.error("blob-storage-migrate failed (command_unavailable)");
    return 1;
  }

  try {
    const status = await command.runBlobStorageMigrationCli(commandArgv, env);
    if (status === undefined) return 0;
    if (!Number.isInteger(status) || status < 0 || status > 255) {
      console.error("blob-storage-migrate failed (invalid_exit_status)");
      return 1;
    }
    return status;
  } catch (error) {
    // The formatter exposes only the command's bounded, operator-safe error vocabulary. Never
    // print the raw exception because it can contain a DSN, endpoint, local path, or credential.
    try {
      console.error(command.formatBlobStorageMigrationCliError(error));
    } catch {
      console.error("blob-storage-migrate failed (internal_error)");
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().then(
    (status) => { process.exitCode = status; },
    () => {
      console.error("blob-storage-migrate failed (internal_error)");
      process.exitCode = 1;
    },
  );
}
