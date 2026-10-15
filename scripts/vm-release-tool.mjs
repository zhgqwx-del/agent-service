#!/usr/bin/env node
// Independent transport consumer. Bundle this module with its audited libraries; runtime
// needs only Node builtins, not the source checkout, pnpm, application config or credentials.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { packVmReleaseArchive, unpackVmReleaseArchive } from "./lib/vm-release-archive.mjs";
import { verifyVmReleaseDirectory } from "./lib/vm-release.mjs";
import {
  inspectSignedVmReleaseTransport, unpackSignedVmReleaseTransport, vmReleaseConsumerToolSha256,
} from "./lib/vm-release-signed.mjs";

const HELP = `Usage: vm-release-tool <command> [options]

Commands:
  pack    --release <absolute-directory> --role agent-runner|agent-router
          --manifest-sha256 <trusted-sha256> --archive <new-absolute-tar>
  unpack  --archive <absolute-tar> --role agent-runner|agent-router
          --archive-sha256 <trusted-sha256> --manifest-sha256 <trusted-sha256>
          --output <new-absolute-directory>
  verify  --release <absolute-directory> --role agent-runner|agent-router
          --manifest-sha256 <trusted-sha256>
  inspect-signed --archive <absolute-tar> --role agent-runner|agent-router
          --signature <absolute-signature.json> --public-key <absolute-SPKI-PEM>
          --public-key-sha256 <trusted-SPKI-sha256> --source-commit <selected-commit>
  unpack-signed  Same signed selectors as inspect-signed, plus
          --output <new-absolute-directory>

Node 24 and the exact target OS/CPU are required. Obtain archive, manifest and tool digests from
an independent trusted channel before use; proof.json or an embedded checksum cannot authenticate
itself. Existing output targets are never overwritten. No service, application, DDL or installation
is started. Signed commands authenticate the exact selected release and the running tool's own
bytes; they require an independently trusted tool, public-key pin and selected role/commit, with
no unsigned fallback. They do not prove freshness, revocation, promotion or production acceptance.

Options:
  -h, --help  Show this help without opening release or archive resources.
`;

const KEYS = Object.freeze({
  pack: Object.freeze(["command", "release", "role", "manifestSha256", "archive"]),
  unpack: Object.freeze(["command", "archive", "role", "archiveSha256", "manifestSha256", "output"]),
  verify: Object.freeze(["command", "release", "role", "manifestSha256"]),
  "inspect-signed": Object.freeze(["command", "archive", "role", "signature", "publicKey", "publicKeySha256", "sourceCommit"]),
  "unpack-signed": Object.freeze(["command", "archive", "role", "signature", "publicKey", "publicKeySha256", "sourceCommit", "output"]),
  help: Object.freeze(["command"]),
});
const FLAGS = Object.freeze({
  "--release": "release", "--role": "role", "--manifest-sha256": "manifestSha256",
  "--archive": "archive", "--archive-sha256": "archiveSha256", "--output": "output",
  "--signature": "signature", "--public-key": "publicKey",
  "--public-key-sha256": "publicKeySha256", "--source-commit": "sourceCommit",
});

function invalid() { throw new Error("vm-release-tool failed (operation_failed)"); }
function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function requireNode24() {
  if (Number(process.versions.node.split(".")[0]) !== 24) invalid();
}
function isDigest(value) { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function isPath(value) {
  return typeof value === "string" && value !== "" && isAbsolute(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function validateInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || typeof input.command !== "string" || !Object.hasOwn(KEYS, input.command)
    || !hasExactKeys(input, KEYS[input.command])) invalid();
  if (input.command === "help") return input;
  if (typeof input.role !== "string" || !["agent-runner", "agent-router"].includes(input.role)
    || (Object.hasOwn(input, "manifestSha256") && !isDigest(input.manifestSha256))
    || (Object.hasOwn(input, "archiveSha256") && !isDigest(input.archiveSha256))
    || (Object.hasOwn(input, "publicKeySha256") && !isDigest(input.publicKeySha256))
    || (Object.hasOwn(input, "sourceCommit") && (typeof input.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(input.sourceCommit)))
    || ["release", "archive", "output", "signature", "publicKey"].some((key) => Object.hasOwn(input, key) && !isPath(input[key]))) invalid();
  return input;
}

/** Parse a closed vocabulary before any filesystem access. Never coerce caller values. */
export function parseVmReleaseToolArgs(args) {
  if (!Array.isArray(args) || args.length > 17
    || Array.from(args).some((value) => typeof value !== "string")) invalid();
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { command: "help" };
  const command = args[0];
  if (typeof command !== "string" || !["pack", "unpack", "verify", "inspect-signed", "unpack-signed"].includes(command)
    || (args.length - 1) % 2 !== 0) invalid();
  const input = { command };
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    if (!Object.hasOwn(FLAGS, flag)) invalid();
    const key = FLAGS[flag];
    if (!KEYS[command].includes(key) || Object.hasOwn(input, key)) invalid();
    input[key] = args[i + 1];
  }
  return validateInput(input);
}

function archiveProof(receipt, input) {
  const keys = ["schema", "role", "targetRuntime", "manifestSha256", "archiveSha256", "archiveBytes", "entryCount", "productionAccepted"];
  if (!hasExactKeys(receipt, keys) || receipt.schema !== "agent-service-vm-release-archive-v1"
    || receipt.role !== input.role || receipt.manifestSha256 !== input.manifestSha256
    || !isDigest(receipt.archiveSha256)
    || (input.command === "unpack" && receipt.archiveSha256 !== input.archiveSha256)
    || !Number.isSafeInteger(receipt.archiveBytes) || receipt.archiveBytes <= 0
    || !Number.isSafeInteger(receipt.entryCount) || receipt.entryCount <= 0
    || receipt.productionAccepted !== false
    || !hasExactKeys(receipt.targetRuntime, ["nodeMajor", "platform", "arch"])
    || receipt.targetRuntime.nodeMajor !== 24
    || receipt.targetRuntime.platform !== process.platform || receipt.targetRuntime.arch !== process.arch) invalid();
  return {
    schema: receipt.schema, role: receipt.role,
    targetRuntime: { nodeMajor: 24, platform: receipt.targetRuntime.platform, arch: receipt.targetRuntime.arch },
    manifestSha256: receipt.manifestSha256, archiveSha256: receipt.archiveSha256,
    archiveBytes: receipt.archiveBytes, entryCount: receipt.entryCount, productionAccepted: false,
  };
}

/** No stdout, ambient config, application startup or subprocess belongs to this consumer API. */
export async function runVmReleaseTool(input) {
  try {
  requireNode24();
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalid();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some((key) => typeof key !== "string"
      || !Object.getOwnPropertyDescriptor(input, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), "value"))) invalid();
  input = Object.freeze({ ...input });
  validateInput(input);
  if (input.command === "help") return { schema: "agent-service-vm-release-tool-help-v1", productionAccepted: false };
  if (input.command === "inspect-signed" || input.command === "unpack-signed") {
    const { command, ...selectors } = input;
    // import.meta.url is this very executable after bundling, never a caller-selected --tool.
    const ownToolSha256 = await vmReleaseConsumerToolSha256(fileURLToPath(import.meta.url));
    return command === "inspect-signed"
      ? await inspectSignedVmReleaseTransport(selectors, ownToolSha256)
      : await unpackSignedVmReleaseTransport(selectors, ownToolSha256);
  }
  if (input.command === "pack") {
    return archiveProof(await packVmReleaseArchive({
      release: input.release, role: input.role, manifestSha256: input.manifestSha256, archive: input.archive,
    }), input);
  }
  if (input.command === "unpack") {
    return archiveProof(await unpackVmReleaseArchive({
      archive: input.archive, role: input.role, archiveSha256: input.archiveSha256,
      manifestSha256: input.manifestSha256, output: input.output,
    }), input);
  }
  const manifest = await verifyVmReleaseDirectory(input.release, input.role, input.manifestSha256);
  return {
    schema: "agent-service-vm-release-verification-v1", role: input.role,
    targetRuntime: { nodeMajor: 24, platform: manifest.targetRuntime.platform, arch: manifest.targetRuntime.arch },
    manifestSha256: input.manifestSha256, entryCount: manifest.files.length, productionAccepted: false,
  };
  } catch { invalid(); }
}

export function isDirectVmReleaseToolEntrypoint(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof importMetaUrl !== "string" || typeof argv1 !== "string" || argv1 === "") return false;
  try {
    const moduleUrl = new URL(importMetaUrl);
    if (moduleUrl.protocol !== "file:" || moduleUrl.search !== "" || moduleUrl.hash !== "") return false;
    const modulePath = realpathSync(fileURLToPath(moduleUrl));
    const invokedPath = realpathSync(argv1);
    return modulePath === invokedPath && statSync(modulePath).isFile() && statSync(invokedPath).isFile();
  } catch { return false; }
}

export async function main(args = process.argv.slice(2)) {
  try {
    requireNode24();
    const input = parseVmReleaseToolArgs(args);
    if (input.command === "help") { process.stdout.write(HELP); return 0; }
    process.stdout.write(`${JSON.stringify(await runVmReleaseTool(input))}\n`);
    return 0;
  } catch {
    process.stderr.write("vm-release-tool failed (operation_failed)\n");
    return 1;
  }
}

if (isDirectVmReleaseToolEntrypoint(import.meta.url)) {
  main().then((status) => { process.exitCode = status; }, () => {
    process.stderr.write("vm-release-tool failed (operation_failed)\n"); process.exitCode = 1;
  });
}
