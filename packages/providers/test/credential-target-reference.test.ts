import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  protectProviderCredentialTargetReference,
  type CredentialTargetReferenceProtector,
} from "../src/index.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("credential target reference protection", () => {
  it("emits only protected bytes and exact raw-byte digests", async () => {
    const plaintext = Buffer.from([0, 1, 2, 3, 255]);
    const plaintextSha256 = sha256(plaintext);
    const ciphertext = Buffer.from([9, 8, 7, 6]);
    let protectorInput: Uint8Array | undefined;
    const protector: CredentialTargetReferenceProtector = {
      protect: vi.fn(async (input) => {
        protectorInput = input;
        expect(input).not.toBe(plaintext);
        expect(Buffer.from(input)).toEqual(plaintext);
        return { ciphertext, keyId: "target-ref-local-v1" };
      }),
    };

    const result = await protectProviderCredentialTargetReference({
      adapterProtocol: "fixture-revoke-v1",
      opaqueReference: plaintext,
    }, protector);

    expect(result).toEqual({
      domain: "external_credential",
      disposition: "executable_ref",
      adapterProtocol: "fixture-revoke-v1",
      targetReferenceCipher: ciphertext,
      targetReferenceKeyId: "target-ref-local-v1",
      targetReferenceCipherSha256: sha256(ciphertext),
      targetReferenceSha256: plaintextSha256,
    });
    expect(result.targetReferenceCipher).not.toBe(ciphertext);
    expect(Buffer.from(protectorInput!)).toEqual(Buffer.alloc(plaintext.length));
    expect(plaintext).toEqual(Buffer.alloc(plaintext.length));

    ciphertext.fill(0);
    expect(result.targetReferenceCipher).toEqual(Buffer.from([9, 8, 7, 6]));
  });

  it.each([
    [{ adapterProtocol: "bad protocol", opaqueReference: Buffer.from("x") }, /protocol is invalid/],
    [{ adapterProtocol: "fixture-v1", opaqueReference: Buffer.alloc(0) }, /1 to 4096 bytes/],
    [{
      adapterProtocol: "fixture-v1",
      opaqueReference: Buffer.from("x"),
      publicLocator: "must-not-pass",
    }, /unknown or missing fields/],
  ] as const)("rejects malformed captured references %#", async (captured, expected) => {
    await expect(protectProviderCredentialTargetReference(captured, {
      protect: async () => ({ ciphertext: Buffer.from("cipher"), keyId: "target-key-v1" }),
    })).rejects.toThrow(expected);
  });

  it("rejects malformed protector output without returning plaintext or partial metadata", async () => {
    const retained: Uint8Array[] = [];
    await expect(protectProviderCredentialTargetReference({
      adapterProtocol: "fixture-v1",
      opaqueReference: Buffer.from("opaque-reference"),
    }, {
      protect: async (input) => {
        retained.push(input);
        return { ciphertext: Buffer.alloc(0), keyId: "target-key-v1" };
      },
    })).rejects.toThrow(/1 to 8192 bytes/);
    expect(Buffer.from(retained[0]!)).toEqual(Buffer.alloc("opaque-reference".length));
  });

  it("clears factory-owned bytes when validation fails before protection", async () => {
    const source = Buffer.from("sensitive-management-locator");
    await expect(protectProviderCredentialTargetReference({
      adapterProtocol: "bad protocol",
      opaqueReference: source,
    }, {
      protect: async () => ({ ciphertext: Buffer.from("unused"), keyId: "unused-v1" }),
    })).rejects.toThrow(/protocol is invalid/);
    expect(source).toEqual(Buffer.alloc(source.length));
  });
});
