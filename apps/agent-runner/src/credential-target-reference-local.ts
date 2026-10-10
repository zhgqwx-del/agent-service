import { createHmac, hkdfSync } from "node:crypto";
import { FAKE_CREDENTIAL_TARGET_EXECUTION_ADAPTER_PROTOCOL } from "@agent-service/core";
import {
  LocalAesGcmCipher,
  type CredentialTargetReferenceProtector,
  type ProviderCredentialTargetReferenceFactory,
} from "@agent-service/providers";

const DERIVATION_SALT = Buffer.from(
  "agent-service-local-credential-target-reference-salt-v1",
  "utf8",
);
const REFERENCE_ENCRYPTION_INFO = Buffer.from(
  "agent-service/credential-target-reference/aes-256-gcm/v1",
  "utf8",
);
const LOCATOR_HMAC_INFO = Buffer.from(
  "agent-service/credential-target-reference/fake-locator-hmac/v1",
  "utf8",
);

/**
 * Build the local fake capture boundary. HKDF derives separate encryption and keyed-locator
 * domains from the local master key; no key material is exposed to callers.
 */
export function createLocalFakeCredentialTargetReferenceCapture(masterKeyHex: string): {
  factory: ProviderCredentialTargetReferenceFactory;
  protector: CredentialTargetReferenceProtector;
} {
  if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    throw new Error("credential target reference master key must be 32 bytes hex");
  }
  const inputKey = Buffer.from(masterKeyHex, "hex");
  const referenceEncryptionKey = Buffer.from(hkdfSync(
    "sha256",
    inputKey,
    DERIVATION_SALT,
    REFERENCE_ENCRYPTION_INFO,
    32,
  ));
  const locatorHmacKey = Buffer.from(hkdfSync(
    "sha256",
    inputKey,
    DERIVATION_SALT,
    LOCATOR_HMAC_INFO,
    32,
  ));
  inputKey.fill(0);
  const cipher = new LocalAesGcmCipher(
    referenceEncryptionKey.toString("hex"),
    "local-credential-target-reference-v1",
  );
  referenceEncryptionKey.fill(0);

  return {
    factory: {
      capture: async (context) => ({
        adapterProtocol: FAKE_CREDENTIAL_TARGET_EXECUTION_ADAPTER_PROTOCOL,
        // A stable server-owned locator derived only from the trusted identity tuple. Tenant URL,
        // header and secret values never enter this factory.
        opaqueReference: createHmac("sha256", locatorHmacKey)
          .update(JSON.stringify([
            "agent-service/local-fake-provider-locator/v1",
            context.tenantId,
            context.providerId,
            context.providerApi,
          ]))
          .digest(),
      }),
    },
    protector: {
      protect: async (plaintext) => ({
        ciphertext: await cipher.encrypt(Buffer.from(plaintext).toString("base64url")),
        keyId: cipher.keyId,
      }),
    },
  };
}
