import { KeyObject, createHash, createPublicKey, sign, verify } from "node:crypto";
import { TextDecoder } from "node:util";

const STATEMENT_SCHEMA = "agent-service-vm-release-statement-v1";
const ENVELOPE_SCHEMA = "agent-service-vm-release-signature-v1";
const ERROR_MESSAGE = "invalid VM release signature";
const MAX_BYTES = 16 * 1024;
const DOMAIN = Buffer.from(`${ENVELOPE_SCHEMA}\0Ed25519\0`, "utf8");
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const STATEMENT_FIELDS = Object.freeze([
  "schema", "role", "sourceCommit", "inputSha256", "lockSha256", "manifestSha256",
  "archiveSha256", "toolSha256", "targetRuntime", "archiveBytes", "entryCount",
  "sourceDirty", "publishable", "productionAccepted",
]);

function invalid() { throw new Error(ERROR_MESSAGE); }

// Do not invoke accessors, toJSON, or coercion on caller-provided objects. Only
// these closed data fields can be copied into the canonical signed statement.
function fields(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== expected.length || own.some((key) => typeof key !== "string" || !expected.includes(key))) invalid();
  const copy = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}

function digest(value) {
  if (typeof value !== "string" || !SHA256.test(value)) invalid();
  return value;
}

function commit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) invalid();
  return value;
}

function role(value) {
  if (value !== "agent-router" && value !== "agent-runner") invalid();
  return value;
}

function positiveInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
  return value;
}

function targetRuntime(value) {
  const data = fields(value, ["nodeMajor", "platform", "arch"]);
  if (data.nodeMajor !== 24 || !["linux", "darwin"].includes(data.platform)
    || !["x64", "arm64"].includes(data.arch)) invalid();
  return Object.freeze({ nodeMajor: 24, platform: data.platform, arch: data.arch });
}

function statement(value) {
  const data = fields(value, STATEMENT_FIELDS);
  if (data.schema !== STATEMENT_SCHEMA || data.sourceDirty !== false
    || data.publishable !== true || data.productionAccepted !== false) invalid();
  // This insertion order is the versioned wire format, not a generic JSON hash.
  return Object.freeze({
    schema: STATEMENT_SCHEMA,
    role: role(data.role),
    sourceCommit: commit(data.sourceCommit),
    inputSha256: digest(data.inputSha256),
    lockSha256: digest(data.lockSha256),
    manifestSha256: digest(data.manifestSha256),
    archiveSha256: digest(data.archiveSha256),
    toolSha256: digest(data.toolSha256),
    targetRuntime: targetRuntime(data.targetRuntime),
    archiveBytes: positiveInteger(data.archiveBytes, 2 * 1024 * 1024 * 1024),
    entryCount: positiveInteger(data.entryCount, 100_000),
    sourceDirty: false,
    publishable: true,
    productionAccepted: false,
  });
}

function signature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) invalid();
  return value;
}

function envelope(value) {
  const data = fields(value, ["schema", "algorithm", "publicKeySha256", "statement", "signature"]);
  if (data.schema !== ENVELOPE_SCHEMA || data.algorithm !== "Ed25519") invalid();
  return Object.freeze({ schema: ENVELOPE_SCHEMA, algorithm: "Ed25519",
    publicKeySha256: digest(data.publicKeySha256), statement: statement(data.statement),
    signature: signature(data.signature) });
}

function publicKey(value) {
  if (!(value instanceof KeyObject) || value.type !== "public" || value.asymmetricKeyType !== "ed25519") invalid();
  return value;
}

function publicKeyPin(value) {
  return createHash("sha256").update(publicKey(value).export({ type: "spki", format: "der" })).digest("hex");
}

function signingBytes(pin, normalizedStatement) {
  return Buffer.concat([DOMAIN, Buffer.from(pin, "ascii"), Buffer.from([0]),
    Buffer.from(JSON.stringify(normalizedStatement), "utf8")]);
}

function encodedEnvelope(normalizedEnvelope) {
  const bytes = Buffer.from(JSON.stringify(normalizedEnvelope), "utf8");
  if (bytes.length > MAX_BYTES) invalid();
  return bytes;
}

/** The SPKI DER pin must be distributed independently of the signed artifact. */
export function vmReleasePublicKeySha256(key) {
  try { return publicKeyPin(key); } catch { return invalid(); }
}

/** This is release identity evidence, never environment promotion or install authority. */
export function createVmReleaseSignature(value, privateKey, expectedPublicKeySha256) {
  try {
    const pin = digest(expectedPublicKeySha256);
    if (!(privateKey instanceof KeyObject) || privateKey.type !== "private"
      || privateKey.asymmetricKeyType !== "ed25519"
      || publicKeyPin(createPublicKey(privateKey)) !== pin) invalid();
    const normalized = statement(value);
    const signed = sign(null, signingBytes(pin, normalized), privateKey);
    return envelope({ schema: ENVELOPE_SCHEMA, algorithm: "Ed25519", publicKeySha256: pin,
      statement: normalized, signature: signed.toString("base64") });
  } catch { return invalid(); }
}

/** Serializing a well-shaped envelope alone does not authenticate its signature. */
export function serializeVmReleaseSignature(value) {
  try { return encodedEnvelope(envelope(value)); } catch { return invalid(); }
}

/**
 * The caller selects the key pin, role and exact commit through a trusted channel.
 * No embedded key, environment fallback, or general anti-replay claim is made.
 */
export function verifyVmReleaseSignature(bytes, key, expected) {
  try {
    const authority = fields(expected, ["publicKeySha256", "role", "sourceCommit"]);
    const pin = digest(authority.publicKeySha256);
    const expectedRole = role(authority.role);
    const expectedCommit = commit(authority.sourceCommit);
    if (publicKeyPin(key) !== pin || !(bytes instanceof Uint8Array)
      || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) invalid();
    // Copy once: all parsing, canonical comparison and signature verification use
    // exactly these bytes even if the caller later mutates its input view.
    const copy = Buffer.from(bytes);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy);
    const normalized = envelope(JSON.parse(text));
    if (!encodedEnvelope(normalized).equals(copy) || normalized.publicKeySha256 !== pin
      || normalized.statement.role !== expectedRole
      || normalized.statement.sourceCommit !== expectedCommit
      || !verify(null, signingBytes(pin, normalized.statement), publicKey(key),
        Buffer.from(normalized.signature, "base64"))) invalid();
    return normalized.statement;
  } catch { return invalid(); }
}
