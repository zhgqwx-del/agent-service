import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

type Role = "agent-router" | "agent-runner";
interface TargetRuntime { nodeMajor: 24; platform: string; arch: string; }
interface InventoryEntry {
  path: string; kind: "file" | "directory" | "symlink"; sha256: string; size: number;
  mode: string; target?: string; nativeFormat?: string; nativeArch?: string;
}
interface Manifest {
  schema: "agent-service-vm-release-v1"; role: Role; releaseKind: string;
  productionAccepted: false; publishable: boolean; targetRuntime: TargetRuntime;
  source: {
    sourceCommit: string; sourceDirty: boolean; lockSha256: string; inputSha256: string;
    inputFiles: { path: string; sha256: string; size: number }[];
    packageManager: string; buildRuntime: { node: string; platform: string; arch: string };
  };
  build: { installContract: string; bundler: string; dependencyClosure: string;
    entrypoints: string[]; migrationCount: number };
  files: InventoryEntry[];
}
interface ArchiveReceipt {
  schema: string; role: Role; targetRuntime: TargetRuntime; manifestSha256: string;
  archiveSha256: string; archiveBytes: number; entryCount: number; productionAccepted: false;
}
interface Statement {
  schema: "agent-service-vm-release-statement-v1"; role: Role; sourceCommit: string;
  inputSha256: string; lockSha256: string; manifestSha256: string; archiveSha256: string;
  toolSha256: string; targetRuntime: TargetRuntime; archiveBytes: number; entryCount: number;
  sourceDirty: false; publishable: true; productionAccepted: false;
}
interface SignatureEnvelope {
  schema: string; algorithm: string; publicKeySha256: string; statement: Statement; signature: string;
}
interface SignedInspection {
  schema: string; statement: Statement; signatureSha256: string; receipt: ArchiveReceipt;
  publicKeySha256: string; signatureVerified: true; productionAccepted: false;
}
interface SigningReceipt {
  schema: string; role: Role; sourceCommit: string; publicKeySha256: string;
  signatureSha256: string; manifestSha256: string; archiveSha256: string;
  toolSha256: string; productionAccepted: false;
}
interface ReleaseApi {
  VM_RELEASE_ENTRYPOINTS: Readonly<Record<Role, readonly string[]>>;
  validateVmReleasePayload(root: string, role: Role): Promise<InventoryEntry[]>;
  verifyVmReleaseDirectory(root: string, role: Role, digest: string): Promise<Manifest>;
}
interface ArchiveApi {
  packVmReleaseArchive(input: { release: string; role: Role; manifestSha256: string;
    archive: string }): Promise<ArchiveReceipt>;
}
interface SignatureApi {
  createVmReleaseSignature(statement: Statement, privateKey: KeyObject, pin: string): SignatureEnvelope;
  serializeVmReleaseSignature(envelope: SignatureEnvelope): Uint8Array;
  verifyVmReleaseSignature(bytes: Uint8Array, publicKey: KeyObject,
    expected: { role: Role; sourceCommit: string; publicKeySha256: string }): Statement;
}
interface SignedApi {
  signVmReleaseTransport(input: unknown): Promise<SigningReceipt>;
  inspectSignedVmReleaseTransport(input: unknown, toolSha256: unknown): Promise<SignedInspection>;
  unpackSignedVmReleaseTransport(input: unknown, toolSha256: unknown): Promise<SignedInspection>;
  vmReleaseConsumerToolSha256(path: unknown): Promise<string>;
}

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const differentDigest = (value: string) => `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;
const runLocal = promisify(execFile);
const ownedRoots = new Set<string>();
let releaseApi: ReleaseApi;
let archiveApi: ArchiveApi;
let signatureApi: SignatureApi;
let signedApi: SignedApi;

beforeAll(async () => {
  // Import only implementation modules: importing another .test.ts would register its suites.
  releaseApi = await import(new URL("../scripts/lib/vm-release.mjs", import.meta.url).href) as ReleaseApi;
  archiveApi = await import(new URL("../scripts/lib/vm-release-archive.mjs", import.meta.url).href) as ArchiveApi;
  signatureApi = await import(new URL("../scripts/lib/vm-release-signature.mjs", import.meta.url).href) as SignatureApi;
  signedApi = await import(new URL("../scripts/lib/vm-release-signed.mjs", import.meta.url).href) as SignedApi;
});
afterEach(async () => {
  for (const root of ownedRoots) {
    // Only exact directories allocated by this test invocation are recursive cleanup targets.
    await rm(root, { recursive: true, force: true });
    ownedRoots.delete(root);
  }
});

async function absent(path: string) {
  const exists = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  expect(exists).toBe(false);
}
async function rejectedWithoutOutput(operation: Promise<unknown>, output: string) {
  await expect(operation).rejects.toThrow(/^VM signed release failed \(operation_failed\)$/);
  await absent(output);
}
function privateBytes(key: KeyObject) {
  const exported = key.export({ type: "pkcs8", format: "pem" });
  return typeof exported === "string" ? Buffer.from(exported, "utf8") : Buffer.from(exported);
}
async function writePrivate(path: string, key: KeyObject) {
  const material = privateBytes(key);
  try { await writeFile(path, material, { mode: 0o600 }); await chmod(path, 0o600); }
  finally { material.fill(0); }
}

async function fixture(role: Role = "agent-router", dirty = false) {
  const root = await mkdtemp(join(tmpdir(), "agent-service-vm-signed-test-"));
  ownedRoots.add(root);
  await chmod(root, 0o700);
  const release = join(root, "release"), marker = join(root, "application-must-not-run");
  await mkdir(join(release, "dist", "migrations"), { recursive: true });
  await mkdir(join(release, "node_modules", "fixture-package"), { recursive: true });
  await mkdir(join(release, "service"));
  await chmod(release, 0o755);
  await writeFile(join(release, "dist", "package.json"), '{"type":"module"}\n');
  const guardedEntrypoint = 'import { writeFileSync } from "node:fs";\n'
    + `writeFileSync(${JSON.stringify(marker)}, "unexpected application execution");\n`
    + 'throw new Error("signedReleaseFixture must never execute");\n';
  for (const entrypoint of releaseApi.VM_RELEASE_ENTRYPOINTS[role]) {
    await writeFile(join(release, "dist", entrypoint), guardedEntrypoint);
    await writeFile(join(release, "dist", `${entrypoint}.map`), '{}\n');
  }
  await writeFile(join(release, "dist", "migrations", "0001_fixture.sql"), "SELECT 1;\n");
  await writeFile(join(release, "node_modules", "fixture-package", "index.js"), "export {};\n");
  await writeFile(join(release, "service", `${role}.service.template`),
    "[Service]\nExecStart=/this-fixture-must-never-be-started\n");
  const lockBytes = Buffer.from("signed-unit-lock\n");
  const inputFiles = [{ path: "pnpm-lock.yaml", sha256: sha(lockBytes), size: lockBytes.length }];
  const manifest: Manifest = {
    schema: "agent-service-vm-release-v1", role, releaseKind: "node24-platform-process-directory",
    productionAccepted: false, publishable: !dirty,
    targetRuntime: { nodeMajor: 24, platform: process.platform, arch: process.arch },
    source: { sourceCommit: "b".repeat(40), sourceDirty: dirty, lockSha256: sha(lockBytes),
      inputSha256: sha(JSON.stringify(inputFiles)), inputFiles, packageManager: "pnpm@12.5.1",
      buildRuntime: { node: process.versions.node, platform: process.platform, arch: process.arch } },
    build: { installContract: "pnpm install --offline --frozen-lockfile --ignore-scripts",
      bundler: "scripts/build-app.mjs",
      dependencyClosure: `pnpm --filter ./apps/${role} --prod --offline --ignore-scripts --trust-lockfile --frozen-lockfile deploy`,
      entrypoints: releaseApi.VM_RELEASE_ENTRYPOINTS[role].map((name) => `dist/${name}`), migrationCount: 1 },
    files: await releaseApi.validateVmReleasePayload(release, role),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(release, "release-manifest.json"), manifestBytes);
  await chmod(join(release, "release-manifest.json"), 0o644);
  const manifestSha256 = sha(manifestBytes), archive = join(root, "release.tar");
  const receipt = await archiveApi.packVmReleaseArchive({ release, role, manifestSha256, archive });
  // Test-only ephemeral keys never enter a release, environment, assertion value or log.
  const keys = generateKeyPairSync("ed25519");
  const privateKey = join(root, "signing-private.pem"), publicKey = join(root, "signing-public.pem");
  await writePrivate(privateKey, keys.privateKey);
  await writeFile(publicKey, keys.publicKey.export({ type: "spki", format: "pem" }));
  const publicKeySha256 = sha(keys.publicKey.export({ type: "spki", format: "der" }));
  const tool = join(root, "fixture-consumer.mjs");
  const toolBytes = Buffer.from('throw new Error("fixture tool must never be executed by an IO signature API");\n');
  await writeFile(tool, toolBytes);
  const toolSha256 = sha(toolBytes), signature = join(root, "release-signature.json");
  const output = join(root, "unpacked");
  const signInput = { release, role, manifestSha256, archive, tool, privateKey, publicKeySha256, output: signature };
  const consumerInput = { archive, role, signature, publicKey, publicKeySha256, sourceCommit: manifest.source.sourceCommit };
  return { root, release, role, manifest, manifestSha256, archive, receipt, marker,
    keys, privateKey, publicKey, publicKeySha256, tool, toolBytes, toolSha256, signature,
    output, signInput, consumerInput };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function signedFixture(role: Role = "agent-router") {
  const f = await fixture(role);
  await signedApi.signVmReleaseTransport(f.signInput);
  return f;
}
async function readStatement(f: Fixture) {
  return signatureApi.verifyVmReleaseSignature(await readFile(f.signature), f.keys.publicKey, {
    role: f.role, sourceCommit: f.manifest.source.sourceCommit, publicKeySha256: f.publicKeySha256,
  });
}
async function rewriteValidSignature(f: Fixture, statement: Statement) {
  const envelope = signatureApi.createVmReleaseSignature(statement, f.keys.privateKey, f.publicKeySha256);
  const bytes = signatureApi.serializeVmReleaseSignature(envelope);
  // Prove these negatives carry a genuine, valid signature rather than merely malformed JSON.
  const verified = signatureApi.verifyVmReleaseSignature(bytes, f.keys.publicKey, {
    role: statement.role, sourceCommit: statement.sourceCommit, publicKeySha256: f.publicKeySha256,
  });
  expect(JSON.stringify(verified) === JSON.stringify(statement)).toBe(true);
  await writeFile(f.signature, bytes);
}

describe("offline VM transport signature IO", () => {
  it.each(["agent-router", "agent-runner"] as const)("signs, inspects and really unpacks %s without running payloads", async (role) => {
    const f = await fixture(role);
    const signing = await signedApi.signVmReleaseTransport(f.signInput);
    expect(signing).toMatchObject({ role, sourceCommit: f.manifest.source.sourceCommit,
      publicKeySha256: f.publicKeySha256, archiveSha256: f.receipt.archiveSha256,
      manifestSha256: f.manifestSha256, toolSha256: f.toolSha256, productionAccepted: false });
    const signatureStats = await lstat(f.signature);
    expect(signatureStats.isFile()).toBe(true);
    expect(signatureStats.mode & 0o777).toBe(0o600);
    expect(signatureStats.nlink).toBe(1);
    const signatureBytes = await readFile(f.signature);
    expect(sha(signatureBytes)).toBe(signing.signatureSha256);
    expect(signatureBytes.includes(Buffer.from("PRIVATE KEY"))).toBe(false);
    expect(JSON.stringify(signing).includes("PRIVATE KEY")).toBe(false);
    expect(await signedApi.vmReleaseConsumerToolSha256(f.tool)).toBe(f.toolSha256);
    const inspected = await signedApi.inspectSignedVmReleaseTransport(f.consumerInput, f.toolSha256);
    expect(inspected).toMatchObject({ signatureVerified: true, productionAccepted: false,
      statement: { role, sourceCommit: f.manifest.source.sourceCommit, sourceDirty: false,
        publishable: true, productionAccepted: false, archiveBytes: f.receipt.archiveBytes,
        entryCount: f.manifest.files.length + 1 } });
    await absent(f.output);
    const unpacked = await signedApi.unpackSignedVmReleaseTransport({ ...f.consumerInput, output: f.output }, f.toolSha256);
    expect(unpacked).toMatchObject({ signatureVerified: true, productionAccepted: false,
      receipt: { archiveSha256: f.receipt.archiveSha256, manifestSha256: f.manifestSha256 } });
    const verified = await releaseApi.verifyVmReleaseDirectory(f.output, role, f.manifestSha256);
    expect(verified).toEqual(f.manifest);
    expect((await lstat(f.output)).mode & 0o777).toBe(0o755);
    expect(await readdir(f.release)).toEqual(expect.arrayContaining(["dist", "node_modules", "service", "release-manifest.json"]));
    await absent(f.marker);
    // Re-verifying or copying the exact selected artifact is allowed; this is not a replay ledger.
    const replayOutput = join(f.root, "exact-replay");
    expect((await signedApi.unpackSignedVmReleaseTransport({ ...f.consumerInput, output: replayOutput }, f.toolSha256)).signatureVerified).toBe(true);
    await releaseApi.verifyVmReleaseDirectory(replayOutput, role, f.manifestSha256);
    await absent(f.marker);
  });

  it("accepts an owner-only 0400 private key without altering the key file", async () => {
    const f = await fixture();
    await chmod(f.privateKey, 0o400);
    const before = sha(await readFile(f.privateKey));
    await signedApi.signVmReleaseTransport(f.signInput);
    expect(sha(await readFile(f.privateKey)) === before).toBe(true);
    expect((await lstat(f.privateKey)).mode & 0o777).toBe(0o400);
  });

  it("refuses a valid but unpublishable dirty release", async () => {
    const f = await fixture("agent-router", true);
    await rejectedWithoutOutput(signedApi.signVmReleaseTransport(f.signInput), f.signature);
    await releaseApi.verifyVmReleaseDirectory(f.release, f.role, f.manifestSha256);
  });

  it("requires the explicitly selected private-key pin", async () => {
    const f = await fixture();
    await rejectedWithoutOutput(signedApi.signVmReleaseTransport({ ...f.signInput,
      publicKeySha256: differentDigest(f.publicKeySha256) }), f.signature);
  });

  it.each(["symlink", "fifo", "hardlink", "public-readable", "empty", "oversized", "non-ed25519", "public-only", "multiple-blocks"] as const)(
    "refuses unsafe private-key material: %s", async (kind) => {
      const f = await fixture(), candidate = join(f.root, "candidate-private.pem");
      if (kind === "symlink") await symlink(f.privateKey, candidate);
      else if (kind === "fifo") {
        // Fixed platform utility, bounded and without inherited application credentials.
        await runLocal("/usr/bin/mkfifo", [candidate], { timeout: 2_000, env: { PATH: "/usr/bin:/bin" } });
        await chmod(candidate, 0o600);
      } else if (kind === "hardlink") await link(f.privateKey, candidate);
      else if (kind === "non-ed25519") await writePrivate(candidate, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
      else if (kind === "public-only") await writeFile(candidate, f.keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
      else if (kind === "empty") await writeFile(candidate, Buffer.alloc(0), { mode: 0o600 });
      else if (kind === "oversized") await writeFile(candidate, Buffer.alloc(16 * 1024 + 1, 0x41), { mode: 0o600 });
      else if (kind === "multiple-blocks") {
        const material = privateBytes(f.keys.privateKey);
        const duplicate = Buffer.concat([material, material]);
        try { await writeFile(candidate, duplicate, { mode: 0o600 }); }
        finally { material.fill(0); duplicate.fill(0); }
      } else {
        await writePrivate(candidate, f.keys.privateKey);
        await chmod(candidate, 0o644);
      }
      await rejectedWithoutOutput(signedApi.signVmReleaseTransport({ ...f.signInput, privateKey: candidate }), f.signature);
    });

  it("does not overwrite an existing detached signature", async () => {
    const f = await fixture();
    const sentinel = Buffer.from("pre-existing operator-owned signature bytes");
    await writeFile(f.signature, sentinel, { mode: 0o600 });
    await expect(signedApi.signVmReleaseTransport(f.signInput)).rejects.toThrow(/^VM signed release failed \(operation_failed\)$/);
    expect(sha(await readFile(f.signature))).toBe(sha(sentinel));
  });

  it("cannot write a signature into the verified release", async () => {
    const f = await fixture(), output = join(f.release, "detached-signature.json");
    await rejectedWithoutOutput(signedApi.signVmReleaseTransport({ ...f.signInput, output }), output);
    await releaseApi.verifyVmReleaseDirectory(f.release, f.role, f.manifestSha256);
  });

  it("rejects a writable output parent without creating a signature", async () => {
    const f = await fixture(), parent = join(f.root, "untrusted-output-parent");
    await mkdir(parent); await chmod(parent, 0o777);
    const output = join(parent, "signature.json");
    await rejectedWithoutOutput(signedApi.signVmReleaseTransport({ ...f.signInput, output }), output);
  });

  it.each(["private-pem", "multiple-blocks", "non-ed25519", "oversized", "symlink"] as const)(
    "requires a bounded Ed25519 SPKI public key: %s", async (kind) => {
      const f = await signedFixture(), publicKey = join(f.root, "candidate-public.pem");
      if (kind === "private-pem") await writePrivate(publicKey, f.keys.privateKey);
      else if (kind === "symlink") await symlink(f.publicKey, publicKey);
      else if (kind === "oversized") await writeFile(publicKey, Buffer.alloc(16 * 1024 + 1, 0x41));
      else if (kind === "non-ed25519") {
        await writeFile(publicKey, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }));
      } else {
        const pem = await readFile(f.publicKey);
        await writeFile(publicKey, Buffer.concat([pem, pem]));
      }
      await rejectedWithoutOutput(signedApi.unpackSignedVmReleaseTransport({ ...f.consumerInput, publicKey, output: f.output }, f.toolSha256), f.output);
    });

  it.each(["pin", "different-public-key", "selected-commit", "selected-role", "consumer-tool"] as const)(
    "rejects a different caller-selected release authority: %s", async (kind) => {
      const f = await signedFixture();
      let input = { ...f.consumerInput }, toolSha256 = f.toolSha256;
      if (kind === "pin") input.publicKeySha256 = differentDigest(f.publicKeySha256);
      else if (kind === "different-public-key") {
        await writeFile(f.publicKey, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
      } else if (kind === "selected-commit") input.sourceCommit = "c".repeat(40);
      else if (kind === "selected-role") input.role = f.role === "agent-router" ? "agent-runner" : "agent-router";
      else toolSha256 = differentDigest(f.toolSha256);
      await rejectedWithoutOutput(signedApi.unpackSignedVmReleaseTransport({ ...input, output: f.output }, toolSha256), f.output);
    });

  it.each(["role", "sourceCommit", "inputSha256", "lockSha256", "manifestSha256", "archiveSha256", "archiveBytes", "entryCount", "targetRuntime"] as const)(
    "rejects cryptographically valid but archive-inconsistent signed %s before output creation", async (field) => {
      const f = await signedFixture(), changed = structuredClone(await readStatement(f));
      if (field === "role") changed.role = f.role === "agent-router" ? "agent-runner" : "agent-router";
      else if (field === "sourceCommit") changed.sourceCommit = "c".repeat(40);
      else if (field === "archiveBytes") changed.archiveBytes += 512;
      else if (field === "entryCount") changed.entryCount += 1;
      else if (field === "targetRuntime") changed.targetRuntime.arch = process.arch === "arm64" ? "x64" : "arm64";
      else changed[field] = differentDigest(changed[field]);
      await rewriteValidSignature(f, changed);
      // Match selectors to the signed statement so failure must come from actual archive evidence.
      const input = { ...f.consumerInput, role: changed.role, sourceCommit: changed.sourceCommit };
      await rejectedWithoutOutput(signedApi.unpackSignedVmReleaseTransport({ ...input, output: f.output }, f.toolSha256), f.output);
    });

  it("rejects a changed signature even when its canonical envelope still parses", async () => {
    const f = await signedFixture();
    const envelope = JSON.parse((await readFile(f.signature)).toString("utf8")) as SignatureEnvelope;
    envelope.signature = `${envelope.signature[0] === "A" ? "B" : "A"}${envelope.signature.slice(1)}`;
    await writeFile(f.signature, JSON.stringify(envelope));
    await rejectedWithoutOutput(signedApi.unpackSignedVmReleaseTransport({ ...f.consumerInput, output: f.output }, f.toolSha256), f.output);
  });

  it("does not let a successful inspection authorize later changed archive bytes", async () => {
    const f = await signedFixture();
    expect((await signedApi.inspectSignedVmReleaseTransport(f.consumerInput, f.toolSha256)).signatureVerified).toBe(true);
    const bytes = await readFile(f.archive), offset = bytes.indexOf(Buffer.from("signedReleaseFixture"));
    expect(offset).toBeGreaterThan(0);
    bytes[offset] = bytes[offset]! ^ 1;
    await writeFile(f.archive, bytes);
    await rejectedWithoutOutput(signedApi.unpackSignedVmReleaseTransport({ ...f.consumerInput, output: f.output }, f.toolSha256), f.output);
    await absent(f.marker);
  });

  it.each(["oversized", "production-claim", "environment-authority", "algorithm", "noncanonical"] as const)(
    "rejects unbounded or unauthorized signature wire data: %s", async (kind) => {
      const f = await signedFixture();
      const envelope = JSON.parse((await readFile(f.signature)).toString("utf8")) as SignatureEnvelope & Record<string, unknown>;
      if (kind === "oversized") await writeFile(f.signature, Buffer.alloc(16 * 1024 + 1, 0x41));
      else if (kind === "noncanonical") await writeFile(f.signature, `${JSON.stringify(envelope)}\n`);
      else {
        if (kind === "production-claim") (envelope.statement as unknown as Record<string, unknown>).productionAccepted = true;
        else if (kind === "environment-authority") envelope.environment = "production";
        else envelope.algorithm = "Ed448";
        await writeFile(f.signature, JSON.stringify(envelope));
      }
      await rejectedWithoutOutput(signedApi.unpackSignedVmReleaseTransport({ ...f.consumerInput, output: f.output }, f.toolSha256), f.output);
    });

  it.each(["directory", "file", "symlink"] as const)("does not replace an existing unpack %s", async (kind) => {
    const f = await signedFixture(), sentinel = join(f.root, "untouched-sentinel");
    await writeFile(sentinel, "existing operator data\n");
    if (kind === "directory") {
      await mkdir(f.output, { mode: 0o700 });
      await writeFile(join(f.output, "sentinel"), "keep\n");
    } else if (kind === "file") await writeFile(f.output, "keep\n");
    else await symlink(sentinel, f.output);
    const before = await lstat(f.output);
    await expect(signedApi.unpackSignedVmReleaseTransport({ ...f.consumerInput, output: f.output }, f.toolSha256))
      .rejects.toThrow(/^VM signed release failed \(operation_failed\)$/);
    const after = await lstat(f.output);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    expect(await readFile(sentinel, "utf8")).toBe("existing operator data\n");
    if (kind === "directory") expect(await readFile(join(f.output, "sentinel"), "utf8")).toBe("keep\n");
    else expect(await readFile(f.output, "utf8")).toBe(kind === "file" ? "keep\n" : "existing operator data\n");
  });

  it.each([0, -1, 1.5, 120_001, Number.NaN, Number.POSITIVE_INFINITY])("does not increase or invent a deadline budget (%s)", async (deadlineMs) => {
    const f = await fixture();
    await rejectedWithoutOutput(signedApi.signVmReleaseTransport({ ...f.signInput, deadlineMs }), f.signature);
  });

  it.each(["missing-pin", "missing-role", "missing-commit", "unknown-authority"] as const)(
    "requires explicit closed consumer authority: %s", async (kind) => {
      const f = await signedFixture(), input: Record<string, unknown> = { ...f.consumerInput, output: f.output };
      if (kind === "missing-pin") delete input.publicKeySha256;
      else if (kind === "missing-role") delete input.role;
      else if (kind === "missing-commit") delete input.sourceCommit;
      else input.installAuthorized = true;
      await rejectedWithoutOutput(signedApi.unpackSignedVmReleaseTransport(input, f.toolSha256), f.output);
    });

  it.each(["oversized", "symlink", "hardlink"] as const)("hashes only a bounded, regular actual consumer tool: %s", async (kind) => {
    const f = await fixture(), candidate = join(f.root, "candidate-tool.mjs");
    if (kind === "oversized") await writeFile(candidate, Buffer.alloc(4 * 1024 * 1024 + 1, 0x41));
    else if (kind === "symlink") await symlink(f.tool, candidate);
    else await link(f.tool, candidate);
    await expect(signedApi.vmReleaseConsumerToolSha256(candidate)).rejects.toThrow(/^VM signed release failed \(operation_failed\)$/);
  });
});
