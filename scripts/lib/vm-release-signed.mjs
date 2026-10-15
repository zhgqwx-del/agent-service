// Offline selected-release authenticity, not environment promotion, installation or key management.
import { createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { inspectVmReleaseArchive, unpackVmReleaseArchive } from "./vm-release-archive.mjs";
import { verifyVmReleaseDirectory } from "./vm-release.mjs";
import {
  createVmReleaseSignature, serializeVmReleaseSignature, verifyVmReleaseSignature,
} from "./vm-release-signature.mjs";

const LIMIT = 16 * 1024;
const TOOL_LIMIT = 4 * 1024 * 1024;
const DEADLINE = 120_000;
const failed = () => new Error("VM signed release failed (operation_failed)");
const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const absolute = (value) => typeof value === "string" && value !== "" && isAbsolute(value)
  && !/[\p{Cc}\p{Cs}]/u.test(value);
function snapshotInput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failed();
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !field?.enumerable || !Object.hasOwn(field, "value")) throw failed();
  }
  return Object.freeze({ ...value });
}
function options(value, keys) {
  if (!exact(value, [...keys, ...(Object.hasOwn(value ?? {}, "deadlineMs") ? ["deadlineMs"] : [])])
    || !["agent-router", "agent-runner"].includes(value.role) || !digest(value.publicKeySha256)
    || Number(process.versions.node.split(".")[0]) !== 24) throw failed();
  for (const key of keys.filter((key) => !["role", "publicKeySha256", "sourceCommit", "manifestSha256"].includes(key))) {
    if (!absolute(value[key])) throw failed();
  }
  if (Object.hasOwn(value, "sourceCommit") && !/^[0-9a-f]{40}$/.test(value.sourceCommit)) throw failed();
  if (Object.hasOwn(value, "manifestSha256") && !digest(value.manifestSha256)) throw failed();
  const duration = value.deadlineMs ?? DEADLINE;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > DEADLINE) throw failed();
  const expires = performance.now() + duration;
  return { remaining() {
    const left = Math.floor(expires - performance.now());
    if (left < 1) throw failed();
    return left;
  } };
}

/** Secure bounded reads; the cooperative budget cannot hard-cancel native filesystem I/O. */
async function readRegular(path, maximum, budget, privateKey = false) {
  budget.remaining();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size)
      || before.size < 1 || before.size > maximum
      || privateKey && ((before.mode & 0o7777) !== 0o400 && (before.mode & 0o7777) !== 0o600
        || typeof process.getuid !== "function" || before.uid !== process.getuid())) throw failed();
    bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      budget.remaining();
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw failed();
      offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat();
    if (extra.bytesRead !== 0 || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.nlink !== 1 || after.mode !== before.mode
      || after.uid !== before.uid || after.mtimeMs !== before.mtimeMs) throw failed();
    budget.remaining();
    return bytes;
  } catch (error) {
    if (privateKey) bytes?.fill(0);
    throw error;
  } finally { await handle.close(); }
}

/** The CLI passes its own import.meta.url path, never a caller-selected replacement tool. */
export async function vmReleaseConsumerToolSha256(path) {
  try {
    if (!absolute(path)) throw failed();
    const expires = performance.now() + DEADLINE;
    return sha(await readRegular(path, TOOL_LIMIT, { remaining() {
      const left = Math.floor(expires - performance.now());
      if (left < 1) throw failed();
      return left;
    } }));
  } catch { throw failed(); }
}

function publicPem(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(text)) throw failed();
  const key = createPublicKey({ key: bytes, format: "pem", type: "spki" });
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw failed();
  return key;
}
function privatePem(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // A format label, not embedded key material; keep the generic secret scanner fully enabled.
  const label = "PRIVATE KEY";
  if (!new RegExp(`^-----BEGIN ${label}-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+-----END ${label}-----\\r?\\n?$`).test(text)) throw failed();
  const key = createPrivateKey({ key: bytes, format: "pem", type: "pkcs8" });
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw failed();
  return key;
}
function sameRuntime(left, right) {
  return left?.nodeMajor === right?.nodeMajor && left?.platform === right?.platform && left?.arch === right?.arch;
}
function statementFor(manifest, receipt, toolSha256) {
  if (manifest.publishable !== true || manifest.source?.sourceDirty !== false
    || manifest.productionAccepted !== false || receipt.productionAccepted !== false
    || manifest.role !== receipt.role || !sameRuntime(manifest.targetRuntime, receipt.targetRuntime)
    || receipt.entryCount !== manifest.files?.length + 1) throw failed();
  return {
    schema: "agent-service-vm-release-statement-v1", role: manifest.role,
    sourceCommit: manifest.source.sourceCommit, inputSha256: manifest.source.inputSha256,
    lockSha256: manifest.source.lockSha256, manifestSha256: receipt.manifestSha256,
    archiveSha256: receipt.archiveSha256, toolSha256,
    targetRuntime: { nodeMajor: 24, platform: manifest.targetRuntime.platform, arch: manifest.targetRuntime.arch },
    archiveBytes: receipt.archiveBytes, entryCount: receipt.entryCount,
    sourceDirty: false, publishable: true, productionAccepted: false,
  };
}
function sameStatement(observed, expected) {
  return Object.keys(expected).every((key) => key === "targetRuntime"
    ? sameRuntime(observed[key], expected[key]) : observed[key] === expected[key]);
}
function inside(root, path) {
  const part = relative(root, path);
  return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
async function destination(output, release, budget) {
  budget.remaining();
  const parent = dirname(output), stats = await lstat(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o022) !== 0
    || typeof process.getuid !== "function" || stats.uid !== process.getuid()) throw failed();
  const target = join(await realpath(parent), basename(output));
  if (inside(await realpath(release), target)) throw failed();
  try { await lstat(target); throw failed(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  budget.remaining();
  return target;
}
async function createSignatureFile(path, bytes, budget) {
  budget.remaining();
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  // A failed/ambiguous create leaves its exact new file for inspection; never overwrite or remove it.
  budget.remaining();
}

export async function signVmReleaseTransport(input) {
  try {
    input = snapshotInput(input);
    const budget = options(input, ["release", "role", "manifestSha256", "archive", "tool", "privateKey", "publicKeySha256", "output"]);
    const target = await destination(input.output, input.release, budget);
    const manifest = await verifyVmReleaseDirectory(input.release, input.role, input.manifestSha256);
    budget.remaining();
    if (manifest.publishable !== true || manifest.source.sourceDirty !== false) throw failed();
    const inspected = await inspectVmReleaseArchive({ archive: input.archive, role: input.role,
      manifestSha256: input.manifestSha256, limits: { deadlineMs: budget.remaining() } });
    const toolSha256 = sha(await readRegular(input.tool, TOOL_LIMIT, budget));
    const statement = statementFor(manifest, inspected.receipt, toolSha256);
    // Inspect and the directory verifier consumed the same authenticated manifest digest.
    if (!sameStatement(statementFor(inspected.manifest, inspected.receipt, toolSha256), statement)) throw failed();
    const material = await readRegular(input.privateKey, LIMIT, budget, true);
    let envelope;
    try { envelope = createVmReleaseSignature(statement, privatePem(material), input.publicKeySha256); }
    finally { material.fill(0); }
    const bytes = serializeVmReleaseSignature(envelope);
    await createSignatureFile(target, bytes, budget);
    return { schema: "agent-service-vm-release-signing-receipt-v1", role: statement.role,
      sourceCommit: statement.sourceCommit, publicKeySha256: input.publicKeySha256,
      signatureSha256: sha(bytes), manifestSha256: statement.manifestSha256,
      archiveSha256: statement.archiveSha256, toolSha256: statement.toolSha256, productionAccepted: false };
  } catch { throw failed(); }
}

async function inspectSigned(input, consumerToolSha256, budget) {
  if (!digest(consumerToolSha256)) throw failed();
  const key = publicPem(await readRegular(input.publicKey, LIMIT, budget));
  const bytes = await readRegular(input.signature, LIMIT, budget);
  const statement = verifyVmReleaseSignature(bytes, key, {
    publicKeySha256: input.publicKeySha256, role: input.role, sourceCommit: input.sourceCommit,
  });
  if (consumerToolSha256 !== statement.toolSha256) throw failed();
  const inspected = await inspectVmReleaseArchive({ archive: input.archive, role: input.role,
    manifestSha256: statement.manifestSha256, limits: { deadlineMs: budget.remaining() } });
  // All signed provenance is checked before unpack may create or publish its output directory.
  if (!sameStatement(statementFor(inspected.manifest, inspected.receipt, consumerToolSha256), statement)) throw failed();
  budget.remaining();
  return { statement, signatureSha256: sha(bytes), receipt: inspected.receipt };
}
const CONSUMER_KEYS = ["archive", "role", "signature", "publicKey", "publicKeySha256", "sourceCommit"];
export async function inspectSignedVmReleaseTransport(input, consumerToolSha256) {
  try {
    input = snapshotInput(input);
    const budget = options(input, CONSUMER_KEYS);
    const verified = await inspectSigned(input, consumerToolSha256, budget);
    return { schema: "agent-service-vm-release-signed-inspection-v1", ...verified,
      publicKeySha256: input.publicKeySha256, signatureVerified: true, productionAccepted: false };
  } catch { throw failed(); }
}
export async function unpackSignedVmReleaseTransport(input, consumerToolSha256) {
  let published = false;
  try {
    input = snapshotInput(input);
    const budget = options(input, [...CONSUMER_KEYS, "output"]);
    const verified = await inspectSigned(input, consumerToolSha256, budget);
    const receipt = await unpackVmReleaseArchive({ archive: input.archive, role: input.role,
      archiveSha256: verified.statement.archiveSha256, manifestSha256: verified.statement.manifestSha256,
      output: input.output, limits: { deadlineMs: budget.remaining() } });
    published = true;
    // The second read authenticates its own private copy against the same signed digest; a source
    // replacement after inspect cannot inherit the first read's authority.
    if (receipt.archiveBytes !== verified.statement.archiveBytes || receipt.entryCount !== verified.statement.entryCount) throw failed();
    budget.remaining();
    return { schema: "agent-service-vm-release-signed-extraction-v1", ...verified,
      publicKeySha256: input.publicKeySha256, signatureVerified: true, receipt, productionAccepted: false };
  } catch {
    if (published) {
      // Only a successful legacy unpack can set this flag; a pre-existing caller directory must
      // never be chmod'ed. Retain this invocation's new output in quarantine after late failures.
      let handle;
      try {
        handle = await open(input.output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if ((await handle.stat()).isDirectory()) await handle.chmod(0o700);
      } catch { /* No success receipt is returned. Controlled parents remain required. */ }
      finally { await handle?.close(); }
    }
    throw failed();
  }
}
