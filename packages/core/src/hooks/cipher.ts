import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { TenantWebhookAad, TenantWebhookEnvelope } from "@agent-service/store";

export type TenantWebhookSecret =
  | { readonly purpose: "signing_key"; readonly signingKeyHex: string }
  | { readonly purpose: "invocation_snapshot"; readonly snapshot: unknown }
  | { readonly purpose: "delivery_payload"; readonly request: unknown };
export class TenantWebhookCipherError extends Error {
  constructor() { super("Tenant webhook material is unavailable."); this.name = "TenantWebhookCipherError"; }
}
function bad(): never { throw new TenantWebhookCipherError(); }

/** JSON only: no getters, prototypes, cycles, unsupported values or coercion hooks. */
export function tenantWebhookCanonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(input: unknown, depth: number): string {
    if (depth > 32) bad();
    if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number") { if (!Number.isFinite(input)) bad(); return JSON.stringify(input); }
    if (!input || typeof input !== "object" || seen.has(input) || Object.getOwnPropertySymbols(input).length) bad();
    seen.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype || Object.keys(input).length !== input.length
          || Object.keys(input).some((key, index) => key !== String(index))
          || Object.entries(descriptors).some(([key, d]) => key !== "length" && (!("value" in d) || !d.enumerable))) bad();
        return `[${input.map(item => encode(item, depth + 1)).join(",")}]`;
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))
        || Object.values(descriptors).some(d => !("value" in d) || !d.enumerable)) bad();
      return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${encode(descriptors[key]!.value, depth + 1)}`).join(",")}}`;
    } finally { seen.delete(input); }
  }
  return encode(value, 0);
}
export function tenantWebhookHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(tenantWebhookCanonicalJson(value)).digest("hex");
}
function validateAad(aad: TenantWebhookAad): void {
  const encoded = tenantWebhookCanonicalJson(aad);
  if (Buffer.byteLength(encoded) > 8192 || aad.profile !== "tenant-webhook-secret-aad-v2"
    || !["signing_key", "invocation_snapshot", "delivery_payload"].includes(aad.purpose)
    || !/^[a-f0-9]{64}$/.test(aad.endpointSha256) || !/^[a-f0-9]{64}$/.test(aad.bodyScopesSha256)
    || !Number.isSafeInteger(aad.generation) || aad.generation < 1) bad();
  const keys = ["profile", "purpose", "tenantId", "webhookId", "configVersionId", "generation", "materialId", "subject", "sessionId", "turnId", "callItemId", "phase", "endpointSha256", "bodyScopesSha256"];
  if (Object.keys(aad).sort().join(",") !== keys.sort().join(",")
    || !["preToolUse", "postToolUse"].includes(aad.phase)) bad();
  for (const value of [aad.tenantId, aad.webhookId, aad.configVersionId, aad.materialId]) {
    if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 512 || /[\x00-\x1f\x7f]/.test(value)) bad();
  }
  if (aad.purpose === "signing_key") {
    if (aad.subject !== null || aad.sessionId !== null || aad.turnId !== null || aad.callItemId !== null) bad();
  } else {
    if (!aad.subject || Object.keys(aad.subject).sort().join(",") !== "tenantId,userId"
      || aad.subject.tenantId !== aad.tenantId || typeof aad.subject.userId !== "string" || !aad.subject.userId.length) bad();
    for (const value of [aad.sessionId, aad.turnId, aad.callItemId]) if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 256) bad();
  }
}
function validateSecret(aad: TenantWebhookAad, value: TenantWebhookSecret): void {
  tenantWebhookCanonicalJson(value);
  const extra = aad.purpose === "signing_key" ? "signingKeyHex" : aad.purpose === "delivery_payload" ? "request" : "snapshot";
  if (Object.keys(value).sort().join(",") !== ["purpose", extra].sort().join(",") || value.purpose !== aad.purpose) bad();
  if (value.purpose === "signing_key" && !/^[0-9a-f]{64}$/.test(value.signingKeyHex)) bad();
}
function decode(raw: unknown, size?: number): Buffer {
  if (typeof raw !== "string" || !raw.length || raw.length > 180_000) bad();
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length || bytes.toString("base64") !== raw || size !== undefined && bytes.length !== size) bad();
  return bytes;
}

/** Dedicated HOOKS master key; never a MCP/ref/artifact key or an ambient environment lookup. */
export class TenantWebhookCipher {
  readonly #key: Buffer;
  readonly keyId: string;
  readonly keySha256: string;
  private closed = false;
  constructor(input: { readonly keyId: string; readonly key: Uint8Array }) {
    if (!input || typeof input.keyId !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(input.keyId) || !(input.key instanceof Uint8Array) || input.key.byteLength !== 32) bad();
    this.#key = Buffer.from(input.key); this.keyId = input.keyId;
    this.keySha256 = createHash("sha256").update("tenant-webhook-master-key-identity-v2\0").update(this.#key).digest("hex");
  }
  get identity(): { readonly keyId: string; readonly keySha256: string } { return Object.freeze({ keyId: this.keyId, keySha256: this.keySha256 }); }
  encrypt(aad: TenantWebhookAad, value: TenantWebhookSecret): TenantWebhookEnvelope {
    let bytes: Buffer | undefined;
    try {
      if (this.closed) bad(); validateAad(aad); validateSecret(aad, value);
      bytes = value.purpose === "signing_key" ? Buffer.from(value.signingKeyHex, "hex") : Buffer.from(tenantWebhookCanonicalJson(value));
      if (bytes.length > 65_536) bad();
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#key, iv);
      cipher.setAAD(Buffer.from(tenantWebhookCanonicalJson(aad)));
      return Object.freeze({ profile: "tenant-webhook-aes-256-gcm-v2", keyId: this.keyId, iv: iv.toString("base64"),
        ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]).toString("base64"), tag: cipher.getAuthTag().toString("base64") });
    } catch { return bad(); } finally { bytes?.fill(0); }
  }
  open(aad: TenantWebhookAad, envelope: TenantWebhookEnvelope): TenantWebhookSecret {
    let bytes: Buffer | undefined;
    try {
      if (this.closed) bad(); validateAad(aad); tenantWebhookCanonicalJson(envelope);
      if (Object.keys(envelope).sort().join(",") !== "ciphertext,iv,keyId,profile,tag"
        || envelope.profile !== "tenant-webhook-aes-256-gcm-v2" || envelope.keyId !== this.keyId) bad();
      const decipher = createDecipheriv("aes-256-gcm", this.#key, decode(envelope.iv, 12));
      decipher.setAAD(Buffer.from(tenantWebhookCanonicalJson(aad))); decipher.setAuthTag(decode(envelope.tag, 16));
      bytes = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]);
      if (bytes.length > 65_536) bad();
      if (aad.purpose === "signing_key" && bytes.length !== 32) bad();
      const value: unknown = aad.purpose === "signing_key" ? { purpose: "signing_key", signingKeyHex: bytes.toString("hex") }
        : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      validateSecret(aad, value as TenantWebhookSecret); return Object.freeze(value as TenantWebhookSecret);
    } catch { return bad(); } finally { bytes?.fill(0); }
  }
  signingKeyCommitment(value: string): string {
    if (this.closed || !/^[a-f0-9]{64}$/.test(value)) bad();
    return createHmac("sha256", this.#key).update("tenant-webhook-signing-key-commitment-v2\0").update(value).digest("hex");
  }
  close(): void { this.closed = true; this.#key.fill(0); }
}
