import { createHash } from "node:crypto";
import type { ProviderCredentialTargetReferenceWrite } from "@agent-service/store";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~/-]{0,127}$/;
const MAX_OPAQUE_REFERENCE_BYTES = 4_096;
const MAX_PROTECTED_REFERENCE_BYTES = 8_192;

/**
 * Content-free facts available to a trusted, server-side locator factory. Public provider input
 * never contains a locator, and the factory deliberately receives neither the API key nor header
 * values, base URLs, endpoint parameters or other credential-bearing configuration.
 */
export interface ProviderCredentialTargetReferenceContext {
  tenantId: string;
  providerId: string;
  providerApi: "openai-completions";
  encryptedSecretPresent: boolean;
  customHeadersPresent: boolean;
  endpointParametersPresent: boolean;
}

export interface OpaqueProviderCredentialTargetReference {
  /** Versioned adapter contract understood by a future external revocation worker. */
  adapterProtocol: string;
  /**
   * Adapter-private bytes. Ownership transfers to the protection helper, which clears the supplied
   * view before it returns or throws. Factories must return a dedicated mutable buffer.
   */
  opaqueReference: Uint8Array;
}

/**
 * Trusted deployment integration. Absence means the existing fail-closed blocker remains in use.
 * Implementations must resolve only server-owned mappings; they must not interpret arbitrary
 * tenant input as an external management locator.
 */
export interface ProviderCredentialTargetReferenceFactory {
  capture(
    context: Readonly<ProviderCredentialTargetReferenceContext>,
  ): Promise<OpaqueProviderCredentialTargetReference | undefined>;
}

/** A separate protection boundary from the cipher that encrypts the tenant's BYOK secret. */
export interface CredentialTargetReferenceProtector {
  protect(plaintext: Uint8Array): Promise<{
    ciphertext: Uint8Array;
    keyId: string;
  }>;
}

/**
 * Internal write-side input for the credential ledger. The store assigns credential version,
 * tenant and DB-time identity; callers cannot supply any of those authoritative fields.
 */
export type ProtectedProviderCredentialTargetReference = ProviderCredentialTargetReferenceWrite;

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function identifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} is invalid`);
}

function boundedBytes(value: Uint8Array, maximum: number, name: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    throw new Error(`${name} must contain 1 to ${maximum} bytes`);
  }
  return Buffer.from(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Validate, copy and protect one trusted reference. Only digests and ciphertext leave this helper;
 * both temporary copies and the ownership-transferred source view are cleared before settlement.
 */
export async function protectProviderCredentialTargetReference(
  captured: OpaqueProviderCredentialTargetReference,
  protector: CredentialTargetReferenceProtector,
): Promise<ProtectedProviderCredentialTargetReference> {
  if (!captured || typeof captured !== "object" || Array.isArray(captured)) {
    throw new Error("provider credential target reference is invalid");
  }
  const source = captured.opaqueReference;
  let plaintext: Buffer | undefined;
  let protectorInput: Buffer | undefined;
  try {
    exactKeys(captured, ["adapterProtocol", "opaqueReference"],
      "provider credential target reference");
    identifier(captured.adapterProtocol, "provider credential adapter protocol");
    plaintext = boundedBytes(
      source,
      MAX_OPAQUE_REFERENCE_BYTES,
      "provider credential target reference",
    );
    const targetReferenceSha256 = sha256(plaintext);
    protectorInput = Buffer.from(plaintext);
    const protectedReference = await protector.protect(protectorInput);
    if (!protectedReference
      || typeof protectedReference !== "object"
      || Array.isArray(protectedReference)) {
      throw new Error("protected provider credential target reference is invalid");
    }
    exactKeys(protectedReference, ["ciphertext", "keyId"],
      "protected provider credential target reference");
    identifier(protectedReference.keyId, "provider credential target reference key id");
    const ciphertext = boundedBytes(
      protectedReference.ciphertext,
      MAX_PROTECTED_REFERENCE_BYTES,
      "protected provider credential target reference ciphertext",
    );
    return {
      domain: "external_credential",
      disposition: "executable_ref",
      adapterProtocol: captured.adapterProtocol,
      targetReferenceCipher: ciphertext,
      targetReferenceKeyId: protectedReference.keyId,
      targetReferenceCipherSha256: sha256(ciphertext),
      targetReferenceSha256,
    };
  } finally {
    protectorInput?.fill(0);
    plaintext?.fill(0);
    if (source instanceof Uint8Array) source.fill(0);
  }
}
