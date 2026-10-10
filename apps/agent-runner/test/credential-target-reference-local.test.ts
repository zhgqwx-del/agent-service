import { describe, expect, it } from "vitest";
import { LocalAesGcmCipher } from "@agent-service/providers";
import { createLocalFakeCredentialTargetReferenceCapture } from
  "../src/credential-target-reference-local.js";

const MASTER_KEY = "42".repeat(32);

describe("local fake credential target reference capture", () => {
  it("derives a deterministic server-owned locator without using credential-bearing fields", async () => {
    const capture = createLocalFakeCredentialTargetReferenceCapture(MASTER_KEY);
    const context = {
      tenantId: "tenant-a",
      providerId: "provider-a",
      providerApi: "openai-completions" as const,
      encryptedSecretPresent: true,
      customHeadersPresent: true,
      endpointParametersPresent: true,
    };
    const first = await capture.factory.capture(context);
    const second = await capture.factory.capture({
      ...context,
      encryptedSecretPresent: false,
      customHeadersPresent: false,
      endpointParametersPresent: false,
    });
    expect(first?.adapterProtocol).toBe("fake-external-credential-revoke-v1");
    expect(first?.opaqueReference).toEqual(second?.opaqueReference);
    expect(first?.opaqueReference).toHaveLength(32);
    expect(Buffer.from(first!.opaqueReference).toString("utf8")).not.toContain("tenant-a");
    const isolated = await createLocalFakeCredentialTargetReferenceCapture("43".repeat(32))
      .factory.capture(context);
    expect(isolated?.opaqueReference).not.toEqual(first?.opaqueReference);
  });

  it("uses an HKDF-separated protector key and a distinct envelope key id", async () => {
    const capture = createLocalFakeCredentialTargetReferenceCapture(MASTER_KEY);
    const protectedReference = await capture.protector.protect(
      Buffer.from("server-owned-locator"),
    );
    expect(protectedReference.keyId).toBe("local-credential-target-reference-v1");
    expect(Buffer.from(protectedReference.ciphertext).toString("utf8"))
      .not.toContain("server-owned-locator");

    const byokCipher = new LocalAesGcmCipher(MASTER_KEY, protectedReference.keyId);
    await expect(byokCipher.decrypt(
      Buffer.from(protectedReference.ciphertext),
      protectedReference.keyId,
    )).rejects.toThrow();
  });
});
