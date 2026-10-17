import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
type Role = "agent-router" | "agent-runner";
interface ReleaseApi {
  validateVmReleasePayload(root: string, role: Role): Promise<unknown[]>;
  verifyVmReleaseDirectory(root: string, role: Role, digest: string): Promise<unknown>;
  verifyVmReleaseQuarantinedDirectory(root: string, role: Role, digest: string): Promise<unknown>;
}
interface ToolApi {
  parseVmReleaseToolArgs(args: unknown): { command: string };
  runVmReleaseTool(input: unknown): Promise<Json>;
}
interface TransportApi {
  packageVmTransport(input: { release: string; role: Role; manifestSha256: string; output: string }): Promise<Json>;
  deriveVmTransportCompilerContract(packageBytes: Uint8Array, lockBytes: Uint8Array): { version: string };
}
interface SignatureApi {
  vmReleasePublicKeySha256(key: unknown): string;
  createVmReleaseSignature(statement: unknown, privateKey: unknown, pin: unknown): unknown;
  serializeVmReleaseSignature(envelope: unknown): Buffer;
}
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCES = ["scripts/lib/vm-release-archive.mjs", "scripts/lib/vm-release.mjs",
  "scripts/lib/vm-release-signature.mjs", "scripts/lib/vm-release-signed.mjs",
  "scripts/package-vm-transport.mjs", "scripts/vm-release-tool.mjs"].sort();
const ENTRYPOINTS: Record<Role, readonly string[]> = {
  "agent-router": ["main.js"],
  "agent-runner": ["main.js", "blob-storage-migrate.js", "restore-ledger-reconcile.js", "backup-catalog.js", "telemetry-capture.js"],
};
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const owned = new Set<string>();
let release: ReleaseApi;
let tool: ToolApi;
let transport: TransportApi;
let signature: SignatureApi;
beforeAll(async () => {
  release = await import(new URL("../scripts/lib/vm-release.mjs", import.meta.url).href) as ReleaseApi;
  tool = await import(new URL("../scripts/vm-release-tool.mjs", import.meta.url).href) as ToolApi;
  transport = await import(new URL("../scripts/package-vm-transport.mjs", import.meta.url).href) as TransportApi;
  const importedSignature: unknown = await import(new URL("../scripts/lib/vm-release-signature.mjs", import.meta.url).href);
  signature = importedSignature as SignatureApi;
});
afterEach(async () => {
  for (const directory of owned) {
    await rm(directory, { recursive: true, force: true });
    owned.delete(directory);
  }
});
async function temp() {
  const directory = await mkdtemp(join(tmpdir(), "agent-service-vm-tool-test-"));
  owned.add(directory);
  return directory;
}
async function fixture(role: Role = "agent-router") {
  const root = join(await temp(), "source-release");
  await mkdir(join(root, "dist/migrations"), { recursive: true });
  await mkdir(join(root, "node_modules/fixture"), { recursive: true });
  await mkdir(join(root, "service"));
  await chmod(root, 0o755);
  for (const entrypoint of ENTRYPOINTS[role]) {
    await writeFile(join(root, "dist", entrypoint), 'export const fixture = true;\n');
    await writeFile(join(root, "dist", `${entrypoint}.map`), '{}\n');
  }
  await writeFile(join(root, "dist/package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "dist/migrations/0001_fixture.sql"), 'SELECT 1;\n');
  await writeFile(join(root, "node_modules/fixture/index.js"), 'export {};\n');
  await writeFile(join(root, "service", `${role}.service.template`), '[Service]\n');
  const sourceInputs = await Promise.all(SOURCES.map(async (path) => {
    const bytes = await readFile(join(ROOT, path));
    return { path, sha256: sha(bytes), size: bytes.length };
  }));
  const lock = await readFile(join(ROOT, "pnpm-lock.yaml"));
  const packageBytes = await readFile(join(ROOT, "package.json"));
  const inputFiles = [...sourceInputs, { path: "pnpm-lock.yaml", sha256: sha(lock), size: lock.length },
    { path: "package.json", sha256: sha(packageBytes), size: packageBytes.length }]
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const manifest = {
    schema: "agent-service-vm-release-v1", role,
    releaseKind: "node24-platform-process-directory", productionAccepted: false, publishable: true,
    targetRuntime: { nodeMajor: 24, platform: process.platform, arch: process.arch },
    source: { sourceCommit: "b".repeat(40), sourceDirty: false, lockSha256: sha(lock),
      inputSha256: sha(JSON.stringify(inputFiles)), inputFiles, packageManager: "pnpm@12.5.1",
      buildRuntime: { node: process.versions.node, platform: process.platform, arch: process.arch } },
    build: { installContract: "pnpm install --offline --frozen-lockfile --ignore-scripts",
      bundler: "scripts/build-app.mjs",
      dependencyClosure: `pnpm --filter ./apps/${role} --prod --offline --ignore-scripts --trust-lockfile --frozen-lockfile deploy`,
      entrypoints: ENTRYPOINTS[role].map((entrypoint) => `dist/${entrypoint}`), migrationCount: 1 },
    files: await release.validateVmReleasePayload(root, role),
  };
  const seal = async () => {
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(root, "release-manifest.json"), bytes);
    await chmod(join(root, "release-manifest.json"), 0o644);
    return sha(bytes);
  };
  const manifestSha256 = await seal();
  await release.verifyVmReleaseDirectory(root, role, manifestSha256);
  return { root, manifest, manifestSha256, seal };
}
function invoke(toolPath: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd, env: { PATH: "", NODE_ENV: "test" }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
}

const SIGNED_COMMANDS = ["inspect-signed", "unpack-signed"] as const;
type SignedCommand = typeof SIGNED_COMMANDS[number];
const SIGNED_FLAGS = ["--archive", "--role", "--signature", "--public-key", "--public-key-sha256", "--source-commit"];
function signedArgs(command: SignedCommand, input: {
  archive: string; role: Role; signature: string; publicKey: string; publicKeySha256: string; sourceCommit: string;
}, output?: string): string[] {
  return [command, "--archive", input.archive, "--role", input.role, "--signature", input.signature,
    "--public-key", input.publicKey, "--public-key-sha256", input.publicKeySha256,
    "--source-commit", input.sourceCommit, ...(command === "unpack-signed" ? ["--output", output ?? "/new-release"] : [])];
}
function parseOnlySignedInput(role: Role = "agent-router") {
  return { archive: "/release.tar", role, signature: "/release-signature.json", publicKey: "/public-key.pem",
    publicKeySha256: "a".repeat(64), sourceCommit: "b".repeat(40) };
}
function proofDigest(proof: Json, field: string): string {
  const value = proof[field];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("invalid test transport digest");
  return value;
}
function proofCount(proof: Json, field: string): number {
  const value = proof[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("invalid test transport count");
  return value;
}
async function signedFixture(role: Role) {
  const f = await fixture(role);
  const transportOutput = join(await temp(), "signed-transport");
  const proof = await transport.packageVmTransport({ release: f.root, role,
    manifestSha256: f.manifestSha256, output: transportOutput });
  const toolPath = join(transportOutput, "vm-release-tool.mjs");
  const archive = join(transportOutput, "release.tar");
  const keys = generateKeyPairSync("ed25519");
  const publicKeySha256 = signature.vmReleasePublicKeySha256(keys.publicKey);
  const keyDirectory = await temp();
  const publicKey = join(keyDirectory, "ephemeral-public-key.pem");
  const signaturePath = join(keyDirectory, "release-signature.json");
  // Only this generated public key is written. Private fixture material stays in
  // memory, is never logged/asserted as text, and is not a product signing key.
  await writeFile(publicKey, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600, flag: "wx" });
  const statement = { schema: "agent-service-vm-release-statement-v1", role,
    sourceCommit: f.manifest.source.sourceCommit, inputSha256: f.manifest.source.inputSha256,
    lockSha256: f.manifest.source.lockSha256, manifestSha256: f.manifestSha256,
    archiveSha256: proofDigest(proof, "archiveSha256"), toolSha256: proofDigest(proof, "toolSha256"),
    targetRuntime: f.manifest.targetRuntime, archiveBytes: proofCount(proof, "archiveBytes"),
    entryCount: proofCount(proof, "entryCount"), sourceDirty: false, publishable: true, productionAccepted: false };
  const writeSignature = async (value: unknown, exclusive = false) => {
    const envelope = signature.createVmReleaseSignature(value, keys.privateKey, publicKeySha256);
    const bytes = signature.serializeVmReleaseSignature(envelope);
    await writeFile(signaturePath, bytes, { mode: 0o600, flag: exclusive ? "wx" : "w" });
    return bytes;
  };
  await writeSignature(statement, true);
  expect(proofDigest(proof, "toolSha256")).toBe(sha(await readFile(toolPath)));
  expect(proofDigest(proof, "archiveSha256")).toBe(sha(await readFile(archive)));
  return { ...f, proof, toolPath, archive, statement, writeSignature,
    consumer: { archive, role, signature: signaturePath, publicKey, publicKeySha256,
      sourceCommit: f.manifest.source.sourceCommit } };
}

describe("closed VM transport CLI", () => {
  it.each([["--help"], ["-h"]].map((args) => ({ args })))("accepts bounded help form $args", ({ args }) => {
    expect(tool.parseVmReleaseToolArgs(args).command).toBe("help");
  });
  it.each(["pack", "unpack", "verify"])("accepts the complete %s contract", (command) => {
    const args = command === "pack" ? ["pack", "--release", "/release", "--role", "agent-router",
      "--manifest-sha256", "a".repeat(64), "--archive", "/release.tar"]
      : command === "unpack" ? ["unpack", "--archive", "/release.tar", "--role", "agent-router",
        "--archive-sha256", "b".repeat(64), "--manifest-sha256", "a".repeat(64), "--output", "/new-release"]
        : ["verify", "--release", "/release", "--role", "agent-router", "--manifest-sha256", "a".repeat(64)];
    expect(tool.parseVmReleaseToolArgs(args).command).toBe(command);
  });
  const valid = ["verify", "--release", "/release", "--role", "agent-router", "--manifest-sha256", "a".repeat(64)];
  it.each([
    [], ["help"], ["unknown"], ["verify"], ["verify", "--help", "extra"], [...valid, "--role", "agent-router"],
    [...valid, "--unknown", "value"], [...valid, "--output", "/extra"], [...valid, "--manifest-sha256", "b".repeat(64)],
    ["verify", "--release", "relative", ...valid.slice(3)],
    ["verify", "--release", "/release", "--role", "agent-worker", ...valid.slice(5)],
    [...valid.slice(0, -1), "A".repeat(64)], [...valid.slice(0, -1), "a".repeat(63)],
    ["verify", "--release", "/release", "--role", "agent-router", "--manifest-sha256"],
  ].map((args) => ({ args })))("rejects missing, duplicate, cross-command and noncanonical arguments $args", ({ args }) => {
    expect(() => tool.parseVmReleaseToolArgs(args)).toThrow();
  });
  it.each([null, {}, "verify", ["verify", 1], ["verify", null]].map((args) => ({ args })))("rejects non-string argument shape $args", ({ args }) => {
    expect(() => tool.parseVmReleaseToolArgs(args)).toThrow();
  });

  it.each(SIGNED_COMMANDS.flatMap((command) => (["agent-router", "agent-runner"] as const).map((role) => ({ command, role })) ))(
    "parses exact signed $command $role authority with no unsigned fallback", ({ command, role }) => {
      const input = parseOnlySignedInput(role);
      expect(tool.parseVmReleaseToolArgs(signedArgs(command, input))).toEqual({ command, ...input,
        ...(command === "unpack-signed" ? { output: "/new-release" } : {}) });
    });

  it.each(SIGNED_COMMANDS.flatMap((command) => [...SIGNED_FLAGS, ...(command === "unpack-signed" ? ["--output"] : [])]
    .map((flag) => ({ command, flag }))))("rejects missing signed $command $flag", ({ command, flag }) => {
      const args = signedArgs(command, parseOnlySignedInput());
      args.splice(args.indexOf(flag), 2);
      expect(() => tool.parseVmReleaseToolArgs(args)).toThrow();
    });

  it.each(SIGNED_COMMANDS.flatMap((command) => [...SIGNED_FLAGS, ...(command === "unpack-signed" ? ["--output"] : [])]
    .map((flag) => ({ command, flag }))))("rejects duplicate signed $command $flag including empty duplicate", ({ command, flag }) => {
      const args = signedArgs(command, parseOnlySignedInput());
      expect(() => tool.parseVmReleaseToolArgs([...args, flag, args[args.indexOf(flag) + 1]!])).toThrow();
      expect(() => tool.parseVmReleaseToolArgs([...args, flag, ""])).toThrow();
    });

  it.each(SIGNED_COMMANDS.flatMap((command) => [
    ["--archive", "relative.tar"], ["--signature", "signature.json"], ["--public-key", "public.pem"],
    ["--role", "runner"], ["--public-key-sha256", "A".repeat(64)], ["--public-key-sha256", "a".repeat(63)],
    ["--source-commit", "B".repeat(40)], ["--source-commit", "b".repeat(39)],
    ["--archive", ""], ["--signature", ""], ["--public-key", ""], ["--public-key-sha256", ""], ["--source-commit", ""],
    ...(command === "unpack-signed" ? [["--output", "relative"], ["--output", ""]] : []),
  ].map(([flag, value]) => ({ command, flag: flag!, value: value! }))))("rejects noncanonical signed $command $flag=$value", ({ command, flag, value }) => {
    const args = signedArgs(command, parseOnlySignedInput());
    args[args.indexOf(flag) + 1] = value;
    expect(() => tool.parseVmReleaseToolArgs(args)).toThrow();
  });

  it.each(SIGNED_COMMANDS.flatMap((command) => ["--tool", "--archive-sha256", "--manifest-sha256", "--release", "--allow-unsigned", "--unknown"]
    .map((flag) => ({ command, flag }))))("rejects cross-authority/unknown signed $command $flag", ({ command, flag }) => {
    expect(() => tool.parseVmReleaseToolArgs([...signedArgs(command, parseOnlySignedInput()), flag, "/untrusted"])).toThrow();
  });
});

describe("standalone trusted VM transport artifact", () => {
  it.each(["missing-parent", "existing-output"] as const)("closes checker artifact initializer errors for %s before builds", async (kind) => {
    const cwd = await temp();
    const output = kind === "missing-parent" ? join(cwd, "missing-parent", "new-output") : join(cwd, "existing-output");
    if (kind === "existing-output") {
      await mkdir(output); await writeFile(join(output, "sentinel"), "keep\n");
    }
    const result = invoke(join(ROOT, "scripts/check-vm-release.mjs"), cwd, ["--artifacts", output]);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("VM release verification failed (operation_failed, phase=artifact-directory)\n");
    if (kind === "existing-output") expect(await readFile(join(output, "sentinel"), "utf8")).toBe("keep\n");
    else await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps normal permissions exact while quarantine changes only the isolated root comparison", async () => {
    const f = await fixture();
    await expect(release.verifyVmReleaseQuarantinedDirectory(f.root, "agent-router", f.manifestSha256))
      .rejects.toThrow("0700");
    await chmod(f.root, 0o700);
    await expect(release.verifyVmReleaseDirectory(f.root, "agent-router", f.manifestSha256))
      .rejects.toThrow("complete manifest inventory");
    expect(await release.verifyVmReleaseQuarantinedDirectory(f.root, "agent-router", f.manifestSha256))
      .toMatchObject({ productionAccepted: false });
    expect((await lstat(f.root)).mode & 0o777).toBe(0o700);
    const entrypoint = join(f.root, "dist/main.js");
    // The private full-verification launcher deliberately inherits umask 077, so a fixture
    // file may already be 0600. Mutate the actual sealed mode, not an assumed 0644 baseline.
    const originalMode = (await lstat(entrypoint)).mode & 0o777;
    const changedMode = originalMode ^ 0o040;
    expect(changedMode).not.toBe(originalMode);
    await chmod(entrypoint, changedMode);
    expect((await lstat(entrypoint)).mode & 0o777).toBe(changedMode);
    await expect(release.verifyVmReleaseQuarantinedDirectory(f.root, "agent-router", f.manifestSha256))
      .rejects.toThrow("complete manifest inventory");
    await chmod(entrypoint, originalMode);
    await chmod(f.root, 0o755);
    expect(await release.verifyVmReleaseDirectory(f.root, "agent-router", f.manifestSha256))
      .toMatchObject({ productionAccepted: false });
  });

  it("bundles a digest-bound builtin-only tool, then unpacks and verifies without checkout or pnpm", async () => {
    const f = await fixture();
    const output = join(await temp(), "transport");
    const proof = await transport.packageVmTransport({ release: f.root, role: "agent-router",
      manifestSha256: f.manifestSha256, output });
    expect((await readdir(output)).sort()).toEqual(["release.tar", "transport-proof.json", "vm-release-tool.mjs"]);
    expect(proof.productionAccepted).toBe(false);
    expect(proof.sourceCommit).toBe(f.manifest.source.sourceCommit);
    expect(proof.publishable).toBe(true);
    expect(proof.sourceDirty).toBe(false);
    expect(proof.targetRuntime).toEqual(f.manifest.targetRuntime);
    expect(proof.compiler).toMatchObject({ name: "esbuild", version: "0.28.2",
      boundLockSha256: f.manifest.source.lockSha256, toolchainTrust: "trusted-local-install" });
    const toolPath = join(output, "vm-release-tool.mjs");
    const bytes = await readFile(toolPath);
    expect(proof.toolSha256).toBe(sha(bytes));
    expect(proof.archiveSha256).toBe(sha(await readFile(join(output, "release.tar"))));
    expect(proof.manifestSha256).toBe(f.manifestSha256);
    expect(bytes.toString()).not.toContain(ROOT);
    expect(JSON.parse(await readFile(join(output, "transport-proof.json"), "utf8"))).toEqual(proof);
    const cwd = await temp();
    const help = invoke(toolPath, cwd, ["--help"]);
    expect(help.error).toBeUndefined(); expect(help.status).toBe(0); expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage:");
    const extracted = join(cwd, "extracted");
    const unpack = invoke(toolPath, cwd, ["unpack", "--archive", join(output, "release.tar"),
      "--role", "agent-router", "--archive-sha256", String(proof.archiveSha256),
      "--manifest-sha256", f.manifestSha256, "--output", extracted]);
    expect(unpack.error).toBeUndefined(); expect(unpack.status).toBe(0); expect(unpack.stderr).toBe("");
    expect(JSON.parse(unpack.stdout)).toMatchObject({ role: "agent-router", manifestSha256: f.manifestSha256,
      archiveSha256: proof.archiveSha256, productionAccepted: false });
    expect(await readFile(join(extracted, "dist/main.js"))).toEqual(await readFile(join(f.root, "dist/main.js")));
    const verify = invoke(toolPath, cwd, ["verify", "--release", extracted, "--role", "agent-router",
      "--manifest-sha256", f.manifestSha256]);
    expect(verify.error).toBeUndefined(); expect(verify.status).toBe(0); expect(verify.stderr).toBe("");
    expect(JSON.parse(verify.stdout)).toMatchObject({ schema: "agent-service-vm-release-verification-v1",
      manifestSha256: f.manifestSha256, productionAccepted: false });
    const badOutput = join(cwd, "bad-output");
    const denied = invoke(toolPath, cwd, ["unpack", "--archive", join(output, "release.tar"),
      "--role", "agent-router", "--archive-sha256", "0".repeat(64),
      "--manifest-sha256", f.manifestSha256, "--output", badOutput]);
    expect(denied.status).toBe(1); expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain("operation_failed");
    expect(denied.stderr).not.toContain(cwd);
    await expect(lstat(badOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing-source", "changed-source", "changed-package", "changed-lock"] as const)("refuses %s before creating a transport directory", async (kind) => {
    const f = await fixture();
    const index = f.manifest.source.inputFiles.findIndex((entry) => entry.path === "scripts/vm-release-tool.mjs");
    if (kind === "missing-source") f.manifest.source.inputFiles.splice(index, 1);
    else if (kind === "changed-source") f.manifest.source.inputFiles[index]!.sha256 = "0".repeat(64);
    else {
      const path = kind === "changed-package" ? "package.json" : "pnpm-lock.yaml";
      f.manifest.source.inputFiles.find((entry) => entry.path === path)!.sha256 = "0".repeat(64);
      if (kind === "changed-lock") f.manifest.source.lockSha256 = "0".repeat(64);
    }
    f.manifest.source.inputSha256 = sha(JSON.stringify(f.manifest.source.inputFiles));
    const manifestSha256 = await f.seal();
    const output = join(await temp(), "not-created");
    await expect(transport.packageVmTransport({ release: f.root, role: "agent-router", manifestSha256, output })).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite an existing operator output directory", async () => {
    const f = await fixture(); const output = await temp();
    await writeFile(join(output, "sentinel"), "keep\n");
    await expect(transport.packageVmTransport({ release: f.root, role: "agent-router",
      manifestSha256: f.manifestSha256, output })).rejects.toThrow();
    expect(await readFile(join(output, "sentinel"), "utf8")).toBe("keep\n");
  });

  it("inherits nonpublishable dirty provenance without upgrading it", async () => {
    const f = await fixture();
    f.manifest.source.sourceDirty = true; f.manifest.publishable = false;
    const manifestSha256 = await f.seal();
    const output = join(await temp(), "development-transport");
    const proof = await transport.packageVmTransport({ release: f.root, role: "agent-router", manifestSha256, output });
    expect(proof.sourceDirty).toBe(true); expect(proof.publishable).toBe(false); expect(proof.productionAccepted).toBe(false);
  });

  it("derives the compiler pin only from the exact root importer and matching package specifier", async () => {
    const packageBytes = await readFile(join(ROOT, "package.json"));
    const lock = await readFile(join(ROOT, "pnpm-lock.yaml"));
    expect(transport.deriveVmTransportCompilerContract(packageBytes, lock)).toMatchObject({ version: "0.28.2" });
  });

  it.each(["missing-root", "duplicate-root", "duplicate-esbuild", "missing-esbuild", "specifier-mismatch", "quoted-importers", "duplicate-top-importers", "empty-root", "empty-importer-with-body"] as const)(
    "rejects ambiguous or mismatched compiler input %s without consulting ambient modules", async (kind) => {
      const packageBytes = await readFile(join(ROOT, "package.json"));
      const original = await readFile(join(ROOT, "pnpm-lock.yaml"), "utf8");
      const emptyImporter = "  packages/compiler-empty-fixture: {}\n";
      expect(original).not.toContain("  packages/compiler-empty-fixture:");
      expect(original).toContain("\npackages:\n");
      // A dedicated legal empty importer keeps this negative independent of whether an
      // existing workspace (for example testkit) later acquires real dependencies.
      const baseline = original.replace("\npackages:\n", `\n${emptyImporter}\npackages:\n`);
      expect(transport.deriveVmTransportCompilerContract(packageBytes, Buffer.from(baseline)))
        .toMatchObject({ version: "0.28.2" });
      const block = "      esbuild:\n        specifier: ^0.28.2\n        version: 0.28.2\n";
      expect(baseline).toContain(block);
      const rootStart = baseline.indexOf("  .:\n"), rootEnd = baseline.indexOf("  apps/agent-router:\n", rootStart);
      expect(rootStart).toBeGreaterThan(0); expect(rootEnd).toBeGreaterThan(rootStart);
      const malformed = kind === "missing-root" ? baseline.replace("  .:\n", "  other-root:\n")
        : kind === "duplicate-root" ? baseline.replace("  .:\n", "  .:\n  .:\n")
          : kind === "duplicate-esbuild" ? baseline.replace(block, block + block)
            : kind === "missing-esbuild" ? baseline.replace(block, "")
              : kind === "quoted-importers" ? baseline.replace("\npackages:\n", "\n'importers':\npackages:\n")
                : kind === "duplicate-top-importers" ? baseline.replace("\npackages:\n", "\nimporters:\npackages:\n")
                  : kind === "empty-root" ? baseline.slice(0, rootStart) + "  .: {}\n\n" + baseline.slice(rootEnd)
                    : kind === "empty-importer-with-body" ? baseline.replace(emptyImporter, emptyImporter + "    devDependencies:\n" + block)
                      : baseline.replace(block, block.replace("^0.28.2", "^9.0.0"));
      expect(() => transport.deriveVmTransportCompilerContract(packageBytes, Buffer.from(malformed))).toThrow();
    });

  it.each([
    { label: "root", text: '{"devDependencies":{"esbuild":"^0.28.2"},"devDependencies":{"esbuild":"^0.28.2"}}' },
    { label: "dependency", text: '{"devDependencies":{"esbuild":"^0.28.2","esbuild":"^0.28.2"}}' },
    { label: "escaped-dependency", text: String.raw`{"devDependencies":{"esbuild":"^0.28.2","\u0065sbuild":"^0.28.2"}}` },
    { label: "non-object", text: '{"devDependencies":["esbuild","^0.28.2"]}' },
  ])("rejects duplicate/ambiguous package keys $label instead of trusting JSON last-wins", async ({ text }) => {
    const lock = await readFile(join(ROOT, "pnpm-lock.yaml"));
    expect(() => transport.deriveVmTransportCompilerContract(Buffer.from(text), lock)).toThrow();
  });
});

describe("signed standalone VM release consumer", () => {
  it.each(["agent-router", "agent-runner"] as const)("inspects and unpacks a real signed %s tiny tar with only the standalone bundle", async (role) => {
    const f = await signedFixture(role);
    const cwd = await temp();
    const output = join(cwd, "signed-release");
    const help = invoke(f.toolPath, cwd, ["--help"]);
    expect(help.error).toBeUndefined(); expect(help.status).toBe(0); expect(help.stderr).toBe("");
    expect(help.stdout).toContain("inspect-signed"); expect(help.stdout).toContain("unpack-signed");
    expect(help.stdout).toContain("--public-key-sha256"); expect(help.stdout).toContain("--source-commit");
    const inspected = invoke(f.toolPath, cwd, signedArgs("inspect-signed", f.consumer));
    expect(inspected.error).toBeUndefined(); expect(inspected.status).toBe(0); expect(inspected.stderr).toBe("");
    const signatureSha256 = sha(await readFile(f.consumer.signature));
    expect(JSON.parse(inspected.stdout)).toMatchObject({ schema: "agent-service-vm-release-signed-inspection-v1",
      statement: f.statement, publicKeySha256: f.consumer.publicKeySha256, signatureSha256,
      signatureVerified: true, productionAccepted: false,
      receipt: { role, manifestSha256: f.manifestSha256, archiveSha256: f.statement.archiveSha256,
        archiveBytes: f.statement.archiveBytes, entryCount: f.statement.entryCount, productionAccepted: false } });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    const unpacked = invoke(f.toolPath, cwd, signedArgs("unpack-signed", f.consumer, output));
    expect(unpacked.error).toBeUndefined(); expect(unpacked.status).toBe(0); expect(unpacked.stderr).toBe("");
    expect(JSON.parse(unpacked.stdout)).toMatchObject({ schema: "agent-service-vm-release-signed-extraction-v1",
      statement: f.statement, signatureSha256, publicKeySha256: f.consumer.publicKeySha256,
      signatureVerified: true, productionAccepted: false,
      receipt: { role, manifestSha256: f.manifestSha256, archiveSha256: f.statement.archiveSha256,
        archiveBytes: f.statement.archiveBytes, entryCount: f.statement.entryCount, productionAccepted: false } });
    await release.verifyVmReleaseDirectory(output, role, f.manifestSha256);
    for (const entrypoint of ENTRYPOINTS[role]) {
      expect(await readFile(join(output, "dist", entrypoint))).toEqual(await readFile(join(f.root, "dist", entrypoint)));
    }
    expect((await lstat(f.consumer.publicKey)).mode & 0o777).toBe(0o600);
    expect((await lstat(f.consumer.signature)).mode & 0o777).toBe(0o600);
    expect(sha(await readFile(f.toolPath))).toBe(f.statement.toolSha256);
    expect(sha(await readFile(f.archive))).toBe(f.statement.archiveSha256);
  });

  it.each((["agent-router", "agent-runner"] as const).flatMap((role) => [
    "wrong-pin", "wrong-public-key", "wrong-role", "wrong-commit", "self-tool-hash", "signature-tamper",
  ].map((kind) => ({ role, kind }))))("rejects $role $kind before either signed command creates output", async ({ role, kind }) => {
    const f = await signedFixture(role);
    const cwd = await temp();
    const consumer = { ...f.consumer };
    let toolPath = f.toolPath;
    if (kind === "wrong-pin") consumer.publicKeySha256 = sha("untrusted test key pin");
    else if (kind === "wrong-public-key") {
      const other = generateKeyPairSync("ed25519");
      const publicKey = join(cwd, "different-public-key.pem");
      await writeFile(publicKey, other.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600, flag: "wx" });
      consumer.publicKey = publicKey;
    } else if (kind === "wrong-role") consumer.role = role === "agent-runner" ? "agent-router" : "agent-runner";
    else if (kind === "wrong-commit") consumer.sourceCommit = "c".repeat(40);
    else if (kind === "self-tool-hash") {
      // The altered consumer is still executable and equivalent JS, but its
      // actual import.meta.url bytes must not inherit the old signed digest.
      toolPath = join(cwd, "altered-vm-release-tool.mjs");
      await writeFile(toolPath, Buffer.concat([await readFile(f.toolPath), Buffer.from("\n// altered fixture consumer bytes\n")]), { mode: 0o600, flag: "wx" });
      expect(sha(await readFile(toolPath))).not.toBe(f.statement.toolSha256);
    } else {
      const parsed: unknown = JSON.parse(await readFile(consumer.signature, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || !("signature" in parsed) || typeof parsed.signature !== "string") throw new Error("invalid fixture signature envelope");
      const signatureBytes = Buffer.from(parsed.signature, "base64");
      signatureBytes[0] = signatureBytes[0]! ^ 1;
      await writeFile(consumer.signature, signature.serializeVmReleaseSignature({ ...parsed, signature: signatureBytes.toString("base64") }));
    }
    for (const command of SIGNED_COMMANDS) {
      const output = join(cwd, `${command}-not-created`);
      const result = invoke(toolPath, cwd, signedArgs(command, consumer, output));
      expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
      expect(result.stderr).toBe("vm-release-tool failed (operation_failed)\n");
      expect(result.stderr).not.toContain(cwd);
      expect(result.stderr).not.toContain(consumer.publicKeySha256);
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["agent-router", "agent-runner"] as const)("binds direct API %s to its own source tool bytes and rejects open input keys", async (role) => {
    const f = await signedFixture(role);
    // The imported source API is a different executable consumer from the
    // independent bundle; sign its actual bytes, never supply a tool override.
    const sourceToolSha256 = sha(await readFile(join(ROOT, "scripts/vm-release-tool.mjs")));
    const sourceStatement = { ...f.statement, toolSha256: sourceToolSha256 };
    await f.writeSignature(sourceStatement);
    const result = await tool.runVmReleaseTool({ command: "inspect-signed", ...f.consumer });
    expect(result).toMatchObject({ schema: "agent-service-vm-release-signed-inspection-v1",
      statement: sourceStatement, signatureVerified: true, productionAccepted: false });
    const cwd = await temp();
    for (const command of SIGNED_COMMANDS) {
      for (const extra of ["tool", "toolSha256", "manifestSha256", "archiveSha256", "allowUnsigned", "unexpected"]) {
        const output = join(cwd, `${command}-${extra}-not-created`);
        const input = { command, ...f.consumer, ...(command === "unpack-signed" ? { output } : {}), [extra]: "/untrusted" };
        await expect(tool.runVmReleaseTool(input)).rejects.toThrow(/^vm-release-tool failed \(operation_failed\)$/);
        await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
    // No fallback to unsigned execution when the selected signature fails.
    await f.writeSignature(f.statement);
    await expect(tool.runVmReleaseTool({ command: "inspect-signed", ...f.consumer }))
      .rejects.toThrow(/^vm-release-tool failed \(operation_failed\)$/);
  });
});
