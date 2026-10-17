import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import {
  createMcpEncryptedMaterialAdmission, mcpRegistryDigest, validateMcpSecretAad,
  type McpEncryptedMaterialAdmission, type McpSecretAad, type McpSecretEnvelope, type McpStoredMaterial,
} from "@agent-service/store";

export type McpSecretValue =
  | { readonly purpose: "oauth_state"; readonly codeVerifier: string }
  | { readonly purpose: "oauth_tokens"; readonly tokenType: "Bearer"; readonly accessToken: string; readonly refreshToken: string | null }
  | { readonly purpose: "as_client"; readonly clientSecret: string };
export class McpSecretError extends Error {
  constructor() { super("MCP credential material is unavailable."); this.name = "McpSecretError"; }
}
function failed(): never { throw new McpSecretError(); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function secret(value: unknown, maximum = 16_384, allowSpace = false): asserts value is string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > maximum || (allowSpace ? /[\x00-\x1f\x7f]/ : /[\x00-\x20\x7f]/).test(value)) failed();
}
function validateValue(aad: McpSecretAad, input: unknown): asserts input is McpSecretValue {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) failed();
  const value = input as Record<string, unknown>;
  const fields = aad.purpose === "oauth_state" ? ["purpose", "codeVerifier"]
    : aad.purpose === "oauth_tokens" ? ["purpose", "tokenType", "accessToken", "refreshToken"] : ["purpose", "clientSecret"];
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) failed();
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(input, key); if (!d || !("value" in d) || !d.enumerable) failed(); }
  if (value.purpose !== aad.purpose) failed();
  if (aad.purpose === "oauth_state") {
    secret(value.codeVerifier, 128);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(value.codeVerifier as string)) failed();
  } else if (aad.purpose === "oauth_tokens") {
    if (value.tokenType !== "Bearer") failed(); secret(value.accessToken);
    if (value.refreshToken !== null) secret(value.refreshToken);
  } else secret(value.clientSecret, 16_384, true);
}
function decode(value: unknown, size?: number): Buffer {
  if (typeof value !== "string" || !value.length || value.length > 131_072) failed();
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size) || bytes.length > 65_536) failed();
  return bytes;
}

/** Owns a copy of one explicitly loaded key; never consults environment or key files. */
export class McpCredentialCipher {
  readonly #key: Buffer;
  private closed = false;
  readonly keyId: string;
  readonly keySha256: string;
  constructor(input: { readonly keyId: string; readonly key: Uint8Array }) {
    if (!input || typeof input.keyId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.keyId)
      || !(input.key instanceof Uint8Array) || input.key.byteLength !== 32) failed();
    this.keyId = input.keyId; this.#key = Buffer.from(input.key);
    this.keySha256 = createHash("sha256").update("mcp-credential-key-identity-v1\0").update(this.#key).digest("hex");
  }
  encrypt(aad: McpSecretAad, value: McpSecretValue): McpSecretEnvelope {
    let plaintext: Buffer | undefined;
    try {
      if (this.closed) failed(); validateMcpSecretAad(aad); validateValue(aad, value);
      plaintext = Buffer.from(canonical(value)); if (plaintext.length > 65_536) failed();
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#key, iv);
      cipher.setAAD(Buffer.from(canonical(aad)));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({ profile: "mcp-aes-256-gcm-v1", keyId: this.keyId, iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
    } catch { return failed(); } finally { plaintext?.fill(0); }
  }
  seal(aad: McpSecretAad, value: McpSecretValue): McpEncryptedMaterialAdmission {
    return createMcpEncryptedMaterialAdmission({ aad, envelope: this.encrypt(aad, value) });
  }
  open(material: McpStoredMaterial, expected: McpSecretAad): McpSecretValue {
    let plaintext: Buffer | undefined;
    try {
      if (this.closed) failed(); validateMcpSecretAad(expected); validateMcpSecretAad(material.aad);
      if (material.materialId !== expected.materialId || mcpRegistryDigest("mcp-cipher-aad-v1", material.aad) !== mcpRegistryDigest("mcp-cipher-aad-v1", expected)) failed();
      const envelope = material.envelope;
      if (envelope && Object.values(Object.getOwnPropertyDescriptors(envelope)).some(d => !("value" in d) || !d.enumerable)) failed();
      if (!envelope || Object.keys(envelope).sort().join(",") !== "ciphertext,iv,keyId,profile,tag"
        || envelope.profile !== "mcp-aes-256-gcm-v1" || envelope.keyId !== this.keyId) failed();
      const decipher = createDecipheriv("aes-256-gcm", this.#key, decode(envelope.iv, 12));
      decipher.setAAD(Buffer.from(canonical(expected))); decipher.setAuthTag(decode(envelope.tag, 16));
      plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      validateValue(expected, value);
      // JS strings cannot be reliably zeroed. Minimize lifetime; never log/export
      // this returned object or place it in a shared catalog/pool identity.
      return Object.freeze(value);
    } catch { return failed(); } finally { plaintext?.fill(0); }
  }
  authorizationState(aad: McpSecretAad): string {
    try {
      if (this.closed || aad.purpose !== "oauth_state") failed(); validateMcpSecretAad(aad);
      return createHmac("sha256", this.#key).update("mcp-oauth-state-v1\0").update(canonical(aad)).digest("base64url");
    } catch { return failed(); }
  }
  clientSecretCommitment(aad: McpSecretAad, value: string): string {
    try {
      if (this.closed || aad.purpose !== "as_client") failed(); validateMcpSecretAad(aad); secret(value, 16_384, true);
      // The exact management attempt has a deterministic immutable version ID.
      // Do not let a later observed slot generation change this replay hash;
      // the actual GCM envelope still authenticates its real generation.
      return createHmac("sha256", this.#key).update("mcp-as-client-commitment-v1\0").update(canonical({ ...aad, registrationGeneration: 0 })).update("\0").update(value).digest("hex");
    } catch { return failed(); }
  }
  close(): void { this.closed = true; this.#key.fill(0); }
}
export function mcpOAuthStateSha256(state: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) failed();
  return createHash("sha256").update("mcp-oauth-state-lookup-v1\0").update(state).digest("hex");
}
