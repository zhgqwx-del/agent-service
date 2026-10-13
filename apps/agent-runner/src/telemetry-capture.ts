import { isDirectCliEntrypoint } from "./cli-entrypoint.js";

const HELP = `Usage: telemetry-capture <command>

Controlled local-only, one-shot persisted provider failure capture. Never starts a daemon.
It verifies an already installed schema and never runs DDL. Production is rejected.

Commands:
  status              Read database control state only; active lifecycle requires its exact key.
  preflight           Verify exact bindings and S3 capabilities (creates/deletes probe objects).
  activate-lifecycle  One-way 0033 sink lifecycle activation; does not activate a producer.
  activate-logs       One-way provider-step-error-v2 logs activation; v1/traces stay inactive.
  verify-source       Independently verify one persisted failed-step source and writer evidence.

Authority is accepted only through environment variables and a protected raw 32-byte ref-key file.
No DSN, key, path, endpoint, owner identifier or locator is accepted as a command-line flag.
Fleet stopped/drained/producer-ready ACKs are operator declarations, not automatic proof.
An active database primary restore runtime is required. Existing epochs are never rebound.
Tenant erasure stays blocked; grant, external disposition and completion are not enabled.

Options:
  -h, --help  Show this help without opening resources.
`;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const commandArgv = argv[0] === "--" ? argv.slice(1) : argv;
  if (commandArgv.length === 1 && ["-h", "--help"].includes(commandArgv[0]!)) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const command = await import("./telemetry-capture-cli.js");
    await command.runTelemetryCaptureCli(commandArgv, env);
    return 0;
  } catch {
    // All dependencies are untrusted diagnostic data, including errors thrown before parsing.
    process.stderr.write("telemetry-capture failed (operation_failed)\n");
    return 1;
  }
}

if (isDirectCliEntrypoint(import.meta.url)) {
  main().then(
    (status) => { process.exitCode = status; },
    () => {
      process.stderr.write("telemetry-capture failed (internal_error)\n");
      process.exitCode = 1;
    },
  );
}
