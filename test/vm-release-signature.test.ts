import { beforeAll, describe, expect, it } from "vitest";
import { createHash, createSecretKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

type Role = "agent-router" | "agent-runner";
interface TargetRuntime { nodeMajor: 24; platform: "linux" | "darwin"; arch: "x64" | "arm64"; }
interface Statement {
  schema: "agent-service-vm-release-statement-v1";
  role: Role;
  sourceCommit: string;
  inputSha256: string;
  lockSha256: string;
  manifestSha256: string;
  archiveSha256: string;
  toolSha256: string;
  targetRuntime: TargetRuntime;
  archiveBytes: number;
  entryCount: number;
  sourceDirty: false;
  publishable: true;
  productionAccepted: false;
}
interface Envelope {
  schema: "agent-service-vm-release-signature-v1";
  algorithm: "Ed25519";
  publicKeySha256: string;
  statement: Statement;
  signature: string;
}
interface SignatureApi {
  vmReleasePublicKeySha256(publicKey: unknown): string;
  createVmReleaseSignature(statement: unknown, privateKey: unknown, expectedPublicKeySha256: unknown): Envelope;
  serializeVmReleaseSignature(envelope: unknown): Buffer;
  verifyVmReleaseSignature(bytes: unknown, publicKey: unknown, expected: unknown): Readonly<Statement>;
}

const ERROR = /^invalid VM release signature$/;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const COMMIT = "a".repeat(40);
const DOMAIN = Buffer.from("agent-service-vm-release-signature-v1\0Ed25519\0", "utf8");
const STATEMENT_KEYS = ["schema", "role", "sourceCommit", "inputSha256", "lockSha256", "manifestSha256",
  "archiveSha256", "toolSha256", "targetRuntime", "archiveBytes", "entryCount", "sourceDirty", "publishable", "productionAccepted"];
let api: SignatureApi;
// Ephemeral fixture keys only: no PEM, private DER, environment, key files or output.
const keys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const ecKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pin = sha(keys.publicKey.export({ type: "spki", format: "der" }));
const otherPin = sha(otherKeys.publicKey.export({ type: "spki", format: "der" }));

beforeAll(async () => {
  const imported: unknown = await import(new URL("../scripts/lib/vm-release-signature.mjs", import.meta.url).href);
  api = imported as SignatureApi;
});

function statement(role: Role = "agent-runner"): Statement {
  return { schema: "agent-service-vm-release-statement-v1", role, sourceCommit: COMMIT,
    inputSha256: sha("copied-inputs"), lockSha256: sha("lock"), manifestSha256: sha("manifest"),
    archiveSha256: sha("archive"), toolSha256: sha("tool"),
    targetRuntime: { nodeMajor: 24, platform: "linux", arch: "x64" },
    archiveBytes: 10240, entryCount: 15, sourceDirty: false, publishable: true, productionAccepted: false };
}
function expected(role: Role = "agent-runner") { return { publicKeySha256: pin, role, sourceCommit: COMMIT }; }
function fixture(role: Role = "agent-runner") {
  const envelope = api.createVmReleaseSignature(statement(role), keys.privateKey, pin);
  return { envelope, bytes: api.serializeVmReleaseSignature(envelope) };
}
function wire(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), "utf8"); }
function payload(value: unknown, keyPin = pin): Buffer {
  return Buffer.concat([DOMAIN, Buffer.from(keyPin, "ascii"), Buffer.from([0]), wire(value)]);
}
// Independent raw signer lets invalid-schema tests get past cryptographic validity;
// they must still be rejected by the production closed codec, not just by bad sigs.
function independentlySigned(value: unknown, keyPin = pin, privateKey: KeyObject = keys.privateKey): Buffer {
  return wire({ schema: "agent-service-vm-release-signature-v1", algorithm: "Ed25519",
    publicKeySha256: keyPin, statement: value, signature: sign(null, payload(value, keyPin), privateKey).toString("base64") });
}
function assertRejected(value: unknown, ...overrides: unknown[]) {
  // Explicit undefined must remain invalid, not silently acquire test defaults.
  const key = overrides.length > 0 ? overrides[0] : keys.publicKey;
  const authority = overrides.length > 1 ? overrides[1] : expected();
  expect(() => api.verifyVmReleaseSignature(value, key, authority)).toThrowError(ERROR);
}

describe("VM release Ed25519 signature identity", () => {
  it.each(["agent-router", "agent-runner"] as const)("round-trips %s with real crypto and independent key authority", (role) => {
    const input = statement(role);
    const envelope = api.createVmReleaseSignature(input, keys.privateKey, pin);
    const bytes = api.serializeVmReleaseSignature(envelope);
    const result = api.verifyVmReleaseSignature(bytes, keys.publicKey, expected(role));
    expect(result).toEqual(input);
    expect(api.vmReleasePublicKeySha256(keys.publicKey)).toBe(pin);
    expect(verify(null, payload(input), keys.publicKey, Buffer.from(envelope.signature, "base64"))).toBe(true);
    expect(verify(null, wire(input), keys.publicKey, Buffer.from(envelope.signature, "base64"))).toBe(false);
    expect(verify(null, Buffer.concat([DOMAIN, wire(input)]), keys.publicKey, Buffer.from(envelope.signature, "base64"))).toBe(false);
    expect(envelope.signature).toHaveLength(88);
    expect(Buffer.from(envelope.signature, "base64")).toHaveLength(64);
    expect(Object.keys(envelope)).toEqual(["schema", "algorithm", "publicKeySha256", "statement", "signature"]);
    expect(Object.keys(result)).toEqual(STATEMENT_KEYS);
    expect(Object.keys(result.targetRuntime)).toEqual(["nodeMajor", "platform", "arch"]);
    expect(bytes.toString("utf8")).toBe(JSON.stringify(envelope));
    expect(bytes.at(-1)).toBe("}".charCodeAt(0));
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.statement)).toBe(true);
    expect(Object.isFrozen(envelope.statement.targetRuntime)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.targetRuntime)).toBe(true);
  });

  it.each([
    { platform: "linux", arch: "x64" }, { platform: "linux", arch: "arm64" },
    { platform: "darwin", arch: "x64" }, { platform: "darwin", arch: "arm64" },
  ] as const)("signs metadata for $platform/$arch without pretending to validate a payload host", (target) => {
    const value = { ...statement(), targetRuntime: { nodeMajor: 24, ...target } };
    const bytes = api.serializeVmReleaseSignature(api.createVmReleaseSignature(value, keys.privateKey, pin));
    expect(api.verifyVmReleaseSignature(bytes, keys.publicKey, expected()).targetRuntime).toEqual(value.targetRuntime);
  });

  it("canonicalizes caller field order and copies mutable input before signing", () => {
    const input = statement();
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    const first = api.createVmReleaseSignature(input, keys.privateKey, pin);
    const second = api.createVmReleaseSignature(reordered, keys.privateKey, pin);
    expect(api.serializeVmReleaseSignature(second)).toEqual(api.serializeVmReleaseSignature(first));
    input.targetRuntime.arch = "arm64";
    input.manifestSha256 = sha("later mutation");
    expect(first.statement.targetRuntime.arch).toBe("x64");
    expect(first.statement.manifestSha256).toBe(sha("manifest"));
    const bytes = api.serializeVmReleaseSignature(first);
    const result = api.verifyVmReleaseSignature(new Uint8Array(bytes), keys.publicKey, expected());
    bytes.fill(0);
    expect(result.manifestSha256).toBe(sha("manifest"));
  });

  it("does not upgrade a well-shaped serialized counterfeit to authenticated evidence", () => {
    const { envelope } = fixture();
    const bytes = api.serializeVmReleaseSignature({ ...envelope, signature: Buffer.alloc(64).toString("base64") });
    assertRejected(bytes);
  });

  it.each(["no domain", "no key pin", "different key pin"] as const)("rejects an otherwise valid Ed25519 signature with %s", (variant) => {
    const value = statement();
    const wrongPayload = variant === "no domain" ? wire(value)
      : variant === "no key pin" ? Buffer.concat([DOMAIN, wire(value)])
      : payload(value, otherPin);
    const signed = sign(null, wrongPayload, keys.privateKey);
    expect(verify(null, wrongPayload, keys.publicKey, signed)).toBe(true);
    assertRejected(wire({ schema: "agent-service-vm-release-signature-v1", algorithm: "Ed25519",
      publicKeySha256: pin, statement: value, signature: signed.toString("base64") }));
  });

  it.each([
    ["minimum", 1, 1], ["maximum", 2 * 1024 * 1024 * 1024, 100_000],
  ] as const)("accepts exact %s bounded counts", (_name, archiveBytes, entryCount) => {
    const value = { ...statement(), archiveBytes, entryCount };
    expect(api.verifyVmReleaseSignature(independentlySigned(value), keys.publicKey, expected())).toEqual(value);
  });

  it("requires exact commit selection rather than claiming general anti-replay or promotion", () => {
    const { bytes } = fixture();
    expect(api.verifyVmReleaseSignature(bytes, keys.publicKey, expected()).productionAccepted).toBe(false);
    expect(api.verifyVmReleaseSignature(bytes, keys.publicKey, expected())).toEqual(statement());
    assertRejected(bytes, keys.publicKey, { ...expected(), sourceCommit: "b".repeat(40) });
  });

  it.each([
    ["wrong pin", { publicKeySha256: otherPin }], ["wrong role", { role: "agent-router" }],
    ["wrong commit", { sourceCommit: "b".repeat(40) }],
  ])("rejects independent expected authority: %s", (_label, change) => {
    assertRejected(fixture().bytes, keys.publicKey, { ...expected(), ...change });
  });

  it("rejects a valid other-key envelope even when attacker replaces all embedded metadata", () => {
    const bytes = independentlySigned(statement(), otherPin, otherKeys.privateKey);
    assertRejected(bytes);
    assertRejected(bytes, otherKeys.publicKey);
    assertRejected(fixture().bytes, otherKeys.publicKey, { ...expected(), publicKeySha256: otherPin });
  });

  it.each([undefined, null, "", "A".repeat(64), [pin], pin.slice(1), `${pin}\n`])("requires a primitive exact pin at create (%j)", (badPin) => {
    expect(() => api.createVmReleaseSignature(statement(), keys.privateKey, badPin)).toThrowError(ERROR);
  });

  it("rejects signing under a mismatched private key pin", () => {
    expect(() => api.createVmReleaseSignature(statement(), otherKeys.privateKey, pin)).toThrowError(ERROR);
  });

  it.each([
    ["private", keys.privateKey], ["EC", ecKeys.publicKey], ["secret", createSecretKey(Buffer.alloc(32))],
    ["DER bytes", keys.publicKey.export({ type: "spki", format: "der" })], ["null", null], ["object", {}],
  ])("requires a public Ed25519 KeyObject, not %s", (_label, key) => {
    expect(() => api.vmReleasePublicKeySha256(key)).toThrowError(ERROR);
    assertRejected(fixture().bytes, key);
  });

  it.each([["public", keys.publicKey], ["EC", ecKeys.privateKey], ["null", null], ["object", {}]])(
    "requires a private Ed25519 KeyObject, not %s", (_label, key) => {
      expect(() => api.createVmReleaseSignature(statement(), key, pin)).toThrowError(ERROR);
    });

  it.each([
    undefined, null, [], {}, { ...expected(), extra: true },
    { role: "agent-runner", sourceCommit: COMMIT }, { publicKeySha256: pin, sourceCommit: COMMIT },
    { publicKeySha256: pin, role: "agent-runner" }, { ...expected(), publicKeySha256: [pin] },
    { ...expected(), role: ["agent-runner"] }, { ...expected(), sourceCommit: [COMMIT] },
    { ...expected(), sourceCommit: COMMIT.toUpperCase() },
  ])("rejects absent, open or coercible expected authority (%j)", (authority) => {
    assertRejected(fixture().bytes, keys.publicKey, authority);
  });
});

const invalidStatementFields: [string, unknown][] = [
  ["schema", "agent-service-vm-release-statement-v0"], ["role", "runner"], ["role", ["agent-runner"]],
  ["sourceCommit", "A".repeat(40)], ["sourceCommit", "a".repeat(39)], ["sourceCommit", [COMMIT]],
  ...["inputSha256", "lockSha256", "manifestSha256", "archiveSha256", "toolSha256"].flatMap((field): [string, unknown][] => [
    [field, "A".repeat(64)], [field, "a".repeat(63)], [field, [sha("coercion")]],
  ]),
  ["sourceDirty", true], ["sourceDirty", "false"], ["publishable", false], ["publishable", 1],
  ["productionAccepted", true], ["productionAccepted", "false"],
  ...["archiveBytes", "entryCount"].flatMap((field): [string, unknown][] => [
    [field, 0], [field, -1], [field, 1.1], [field, Number.MAX_SAFE_INTEGER + 1], [field, NaN],
    [field, Infinity], [field, "1"], [field, [1]],
  ]), ["archiveBytes", 2 * 1024 * 1024 * 1024 + 1], ["entryCount", 100_001],
];

describe("VM release closed signed statement", () => {
  it.each(invalidStatementFields)("rejects invalid %s, including independently signed invalid schema (%j)", (field, value) => {
    const input = { ...statement(), [field]: value };
    expect(() => api.createVmReleaseSignature(input, keys.privateKey, pin)).toThrowError(ERROR);
    assertRejected(independentlySigned(input));
  });

  it.each(STATEMENT_KEYS)("rejects missing required signed field %s", (field) => {
    const input: Record<string, unknown> = { ...statement() };
    delete input[field];
    expect(() => api.createVmReleaseSignature(input, keys.privateKey, pin)).toThrowError(ERROR);
    assertRejected(independentlySigned(input));
  });

  it.each([
    null, [], "statement", { ...statement(), extra: true },
    { ...statement(), targetRuntime: null }, { ...statement(), targetRuntime: [] },
    { ...statement(), targetRuntime: { nodeMajor: 24, platform: "linux", arch: "x64", extra: true } },
    { ...statement(), targetRuntime: { platform: "linux", arch: "x64" } },
    { ...statement(), targetRuntime: { nodeMajor: "24", platform: "linux", arch: "x64" } },
    { ...statement(), targetRuntime: { nodeMajor: 24, platform: "win32", arch: "x64" } },
    { ...statement(), targetRuntime: { nodeMajor: 24, platform: ["linux"], arch: "x64" } },
    { ...statement(), targetRuntime: { nodeMajor: 24, platform: "linux", arch: "ia32" } },
    { ...statement(), targetRuntime: { nodeMajor: 24, platform: "linux", arch: ["x64"] } },
  ])("rejects open/non-record/invalid target statement (%j)", (input) => {
    expect(() => api.createVmReleaseSignature(input, keys.privateKey, pin)).toThrowError(ERROR);
    assertRejected(independentlySigned(input));
  });

  it("rejects accessors, symbol or hidden extras and custom prototypes without invoking them", () => {
    let invoked = false;
    const input = { ...statement() };
    Object.defineProperty(input, "manifestSha256", { enumerable: true, get: () => { invoked = true; throw new Error("not exposed"); } });
    expect(() => api.createVmReleaseSignature(input, keys.privateKey, pin)).toThrowError(ERROR);
    expect(invoked).toBe(false);
    const symbolExtra = { ...statement(), [Symbol("not permitted")]: true };
    expect(() => api.createVmReleaseSignature(symbolExtra, keys.privateKey, pin)).toThrowError(ERROR);
    const hiddenExtra = { ...statement() };
    Object.defineProperty(hiddenExtra, "hidden", { value: true });
    expect(() => api.createVmReleaseSignature(hiddenExtra, keys.privateKey, pin)).toThrowError(ERROR);
    expect(() => api.createVmReleaseSignature(Object.assign(Object.create({ inherited: true }), statement()), keys.privateKey, pin)).toThrowError(ERROR);
  });

  it.each([
    ["schema", "agent-service-vm-release-statement-v2"], ["role", "agent-router"], ["sourceCommit", "b".repeat(40)],
    ["inputSha256", sha("other inputs")], ["lockSha256", sha("other lock")], ["manifestSha256", sha("other manifest")],
    ["archiveSha256", sha("other archive")], ["toolSha256", sha("other tool")],
    ["targetRuntime", { nodeMajor: 24, platform: "darwin", arch: "x64" }],
    ["targetRuntime", { nodeMajor: 24, platform: "linux", arch: "arm64" }],
    ["targetRuntime", { nodeMajor: 25, platform: "linux", arch: "x64" }],
    ["archiveBytes", 10241], ["entryCount", 16], ["sourceDirty", true], ["publishable", false], ["productionAccepted", true],
  ])("detects tampering every signed statement field: %s (%j)", (field, value) => {
    const { envelope } = fixture();
    assertRejected(wire({ ...envelope, statement: { ...envelope.statement, [field as string]: value } }));
  });
});

describe("VM release strict canonical signature envelope", () => {
  it.each([
    ["schema", "agent-service-vm-release-signature-v0"], ["algorithm", "RSA-SHA256"], ["algorithm", "ed25519"],
    ["algorithm", null], ["algorithm", ["Ed25519"]], ["publicKeySha256", otherPin],
    ["publicKeySha256", [pin]], ["statement", null], ["statement", []], ["extra", true],
  ])("rejects altered envelope %s (%j)", (field, value) => {
    assertRejected(wire({ ...fixture().envelope, [field as string]: value }));
  });

  it.each(["schema", "algorithm", "publicKeySha256", "statement", "signature"])("rejects missing envelope %s", (field) => {
    const input: Record<string, unknown> = { ...fixture().envelope };
    delete input[field];
    assertRejected(wire(input));
    expect(() => api.serializeVmReleaseSignature(input)).toThrowError(ERROR);
  });

  it.each([
    ["empty", ""], ["base64url", `${"_".repeat(86)}==`], ["unpadded", "A".repeat(86)],
    ["short", Buffer.alloc(63).toString("base64")], ["long", Buffer.alloc(65).toString("base64")],
    ["spaces", `${"A".repeat(85)} ==`], ["newline", `${Buffer.alloc(64).toString("base64")}\n`],
    ["non-string", [Buffer.alloc(64).toString("base64")]],
  ])("rejects noncanonical/incorrect-size signature %s", (_name, value) => {
    const input = { ...fixture().envelope, signature: value };
    assertRejected(wire(input));
    expect(() => api.serializeVmReleaseSignature(input)).toThrowError(ERROR);
  });

  it("rejects nonzero base64 pad bits even though permissive decoding returns the same signature", () => {
    const { envelope } = fixture();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(envelope.signature[85]!);
    const alternate = `${envelope.signature.slice(0, 85)}${alphabet[last + 1]}==`;
    expect(Buffer.from(alternate, "base64")).toEqual(Buffer.from(envelope.signature, "base64"));
    expect(() => api.serializeVmReleaseSignature({ ...envelope, signature: alternate })).toThrowError(ERROR);
    assertRejected(wire({ ...envelope, signature: alternate }));
  });

  it("rejects a changed canonical 64-byte signature", () => {
    const { envelope } = fixture();
    const bytes = Buffer.from(envelope.signature, "base64");
    bytes[0] = bytes[0]! ^ 1;
    assertRejected(wire({ ...envelope, signature: bytes.toString("base64") }));
  });

  it.each([
    ["leading whitespace", (text: string) => ` ${text}`], ["trailing newline", (text: string) => `${text}\n`],
    ["internal whitespace", (text: string) => text.replace('\"algorithm\":', '\"algorithm\" : ')],
    ["root duplicate", (text: string) => text.replace('{\"schema\":', '{\"algorithm\":\"Ed25519\",\"schema\":')],
    ["statement duplicate", (text: string) => text.replace('\"sourceDirty\":false', '\"sourceDirty\":false,\"sourceDirty\":false')],
    ["target duplicate", (text: string) => text.replace('\"nodeMajor\":24', '\"nodeMajor\":24,\"nodeMajor\":24')],
    ["escaped equivalent value", (text: string) => text.replace('agent-runner', '\\u0061gent-runner')],
    ["noncanonical number", (text: string) => text.replace('\"archiveBytes\":10240', '\"archiveBytes\":1.024e4')],
    ["target order", (text: string) => text.replace('\"nodeMajor\":24,\"platform\":\"linux\",\"arch\":\"x64\"', '\"arch\":\"x64\",\"platform\":\"linux\",\"nodeMajor\":24')],
  ] as const)("rejects valid-JSON but noncanonical %s", (_name, mutate) => {
    assertRejected(Buffer.from(mutate(fixture().bytes.toString("utf8")), "utf8"));
  });

  it("rejects reordered envelope keys with an otherwise valid signature", () => {
    const envelope = fixture().envelope;
    assertRejected(wire({ algorithm: envelope.algorithm, schema: envelope.schema, publicKeySha256: pin,
      statement: envelope.statement, signature: envelope.signature }));
  });

  it.each([
    ["truncated JSON", Buffer.from("{")], ["null", Buffer.from("null")], ["array", Buffer.from("[]")],
    ["JSON primitive", Buffer.from("1")], ["empty", Buffer.alloc(0)], ["oversized", Buffer.alloc(16 * 1024 + 1, 32)],
    ["invalid UTF8", Buffer.from([0xc0, 0xaf])], ["truncated UTF8", Buffer.from([0xe2, 0x82])],
  ])("rejects malformed or bounded byte input %s", (_name, bytes) => { assertRejected(bytes); });

  it("rejects UTF8 BOM and replacement decoding rather than authenticating a sanitized encoding", () => {
    const bytes = fixture().bytes;
    assertRejected(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
    assertRejected(Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([0xff]), bytes.subarray(-1)]));
  });

  it.each([undefined, null, "{}", [], new ArrayBuffer(4), { byteLength: 10 }])("rejects non-byte input (%j)", (bytes) => {
    assertRejected(bytes);
  });

  it("never returns original error/input/path/key details or a cause", () => {
    const sensitive = "unit-sensitive-path-and-key-marker";
    const input = new Proxy({}, { ownKeys: () => { throw new Error(sensitive); } });
    let caught: unknown;
    try { api.createVmReleaseSignature(input, keys.privateKey, pin); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) throw new Error("expected closed error");
    expect(caught.message).toBe("invalid VM release signature");
    expect(caught.cause).toBeUndefined();
    expect(caught.message).not.toContain(sensitive);
  });
});
