import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Secret-at-rest abstraction. Production plugs in a KMS (envelope encryption, key rotation, audit);
 * local dev uses AES-256-GCM with a master key from the environment.
 */
export interface SecretCipher {
  readonly keyId: string;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer, keyId: string): Promise<string>;
}

export class LocalAesGcmCipher implements SecretCipher {
  readonly keyId: string;
  private readonly key: Buffer;
  constructor(masterKeyHex: string, keyId = "local-v1") {
    if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) throw new Error("SECRETS_MASTER_KEY must be 32 bytes hex");
    this.key = Buffer.from(masterKeyHex, "hex");
    this.keyId = keyId;
  }
  async encrypt(plaintext: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]);
  }
  async decrypt(ciphertext: Buffer, keyId: string) {
    if (keyId !== this.keyId) throw new Error(`unknown key id ${keyId}`);
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ciphertext.subarray(28)), d.final()]).toString("utf8");
  }
}
