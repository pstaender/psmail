import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../../src/server/crypto/password";
import { decryptSecret, deriveEncryptionKey, encryptSecret, generateSalt } from "../../src/server/crypto/secrets";

describe("password hashing", () => {
  test("hashes and verifies a password", async () => {
    const hash = await hashPassword("s3cret!");
    expect(hash).not.toBe("s3cret!");
    expect(await verifyPassword("s3cret!", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("supports empty passwords (default user)", async () => {
    const hash = await hashPassword("");
    expect(await verifyPassword("", hash)).toBe(true);
    expect(await verifyPassword("not-empty", hash)).toBe(false);
  });
});

describe("account secret encryption", () => {
  test("round-trips plaintext through encrypt/decrypt with the same key", () => {
    const salt = generateSalt();
    const key = deriveEncryptionKey("user-password", salt);

    const encrypted = encryptSecret("super-secret-imap-password", key);
    expect(encrypted).not.toContain("super-secret-imap-password");

    const decrypted = decryptSecret(encrypted, key);
    expect(decrypted).toBe("super-secret-imap-password");
  });

  test("fails to decrypt with a different key", () => {
    const key1 = deriveEncryptionKey("password-a", generateSalt());
    const key2 = deriveEncryptionKey("password-b", generateSalt());

    const encrypted = encryptSecret("secret", key1);
    expect(() => decryptSecret(encrypted, key2)).toThrow();
  });

  test("same password + salt derive the same key deterministically", () => {
    const salt = generateSalt();
    const key1 = deriveEncryptionKey("hunter2", salt);
    const key2 = deriveEncryptionKey("hunter2", salt);
    expect(key1.equals(key2)).toBe(true);
  });
});
