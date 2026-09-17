import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Account credentials (IMAP/SMTP passwords) are encrypted at rest with a key
 * derived from the owning user's login password, so plaintext account
 * passwords never touch disk and are only recoverable while the user has an
 * active, authenticated session.
 */

const SCRYPT_KEYLEN = 32; // AES-256
const IV_LENGTH = 12; // recommended for GCM

/** Derive a symmetric encryption key from a user's password + their stored salt. */
export function deriveEncryptionKey(password: string, saltHex: string): Buffer {
  return scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN);
}

export function generateSalt(): string {
  return randomBytes(16).toString("hex");
}

/** Encrypts `plaintext` with AES-256-GCM. Returns `iv:authTag:ciphertext` (all hex), safe to store as a single TEXT column. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}
