#!/usr/bin/env node
// Explicit offline signing; no .env discovery, production key generation or application startup.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { signVmReleaseTransport } from "./lib/vm-release-signed.mjs";

const HELP = `Usage: sign-vm-release --release <absolute-verified-directory> --role agent-router|agent-runner
  --manifest-sha256 <independently-trusted-sha256> --archive <absolute-release.tar>
  --tool <absolute-vm-release-tool.mjs> --private-key <absolute-private-PKCS8-PEM>
  --public-key-sha256 <independently-trusted-SPKI-sha256> --output <new-absolute-signature.json>

Only clean, publishable Node 24 releases are signed. The private Ed25519 key must be an owner-only
0400/0600 regular single-link file; never pass key bytes as an argument. No key is generated,
copied into a release, printed, discovered from .env, deployed or revoked. Output is create-only.
The signature authenticates this exact selected artifact, not environment promotion, freshness,
installation, or production acceptance. -h/--help opens no release or key resources.
`;
const FLAGS = Object.freeze({
  "--release": "release", "--role": "role", "--manifest-sha256": "manifestSha256",
  "--archive": "archive", "--tool": "tool", "--private-key": "privateKey",
  "--public-key-sha256": "publicKeySha256", "--output": "output",
});
const failed = () => new Error("VM release signing failed (operation_failed)");
export function parseVmReleaseSigningArgs(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw failed();
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) return { help: true };
  if (args.length !== 16) throw failed();
  const input = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!Object.hasOwn(FLAGS, args[index])) throw failed();
    const key = FLAGS[args[index]];
    if (Object.hasOwn(input, key)) throw failed();
    input[key] = args[index + 1];
  }
  if (Object.keys(input).length !== 8 || !["agent-router", "agent-runner"].includes(input.role)
    || !/^[0-9a-f]{64}$/.test(input.manifestSha256) || !/^[0-9a-f]{64}$/.test(input.publicKeySha256)
    || ["release", "archive", "tool", "privateKey", "output"].some((key) => !isAbsolute(input[key])
      || /[\p{Cc}\p{Cs}]/u.test(input[key]))) throw failed();
  return input;
}
export function isDirectVmReleaseSigningEntrypoint(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof importMetaUrl !== "string" || typeof argv1 !== "string" || !isAbsolute(argv1)) return false;
  try {
    const url = new URL(importMetaUrl);
    if (url.protocol !== "file:" || url.search !== "" || url.hash !== "") return false;
    const module = realpathSync(fileURLToPath(url)), invoked = realpathSync(argv1);
    return module === invoked && statSync(module).isFile();
  } catch { return false; }
}
export async function main(args = process.argv.slice(2)) {
  try {
    const input = parseVmReleaseSigningArgs(args);
    if (input.help) { process.stdout.write(HELP); return 0; }
    const receipt = await signVmReleaseTransport(input);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return 0;
  } catch {
    process.stderr.write("VM release signing failed (operation_failed)\n");
    return 1;
  }
}
if (isDirectVmReleaseSigningEntrypoint(import.meta.url)) process.exitCode = await main();
