import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import {
  createAccount,
  decryptAccountCredentials,
  deleteAccount,
  getAccountByEmail,
  getAccountRow,
  listAccounts,
  updateAccount,
} from "../../src/server/models/accounts";
import { ApiError } from "../../src/server/types";

const sampleAccountInput = {
  email: "me@example.com",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  imapUsername: "me@example.com",
  imapPassword: "imap-pw",
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
  smtpUsername: "me@example.com",
  smtpPassword: "smtp-pw",
};

describe("accounts model", () => {
  test("creates an account with encrypted credentials that decrypt back", async () => {
    const db = createTestDb();
    const user = await createUser(db, "alice", "user-pw");
    const key = deriveEncryptionKey("user-pw", generateSalt());

    const account = createAccount(db, user.id, sampleAccountInput, key);
    expect(account.email).toBe("me@example.com");

    const row = getAccountRow(db, account.id);
    expect(row.imap_password_encrypted).not.toContain("imap-pw");

    const creds = decryptAccountCredentials(row, key);
    expect(creds.imapPassword).toBe("imap-pw");
    expect(creds.smtpPassword).toBe("smtp-pw");
  });

  test("lists only accounts owned by the given user", async () => {
    const db = createTestDb();
    const alice = await createUser(db, "alice", "pw");
    const bob = await createUser(db, "bob", "pw");
    const key = deriveEncryptionKey("pw", generateSalt());

    createAccount(db, alice.id, sampleAccountInput, key);
    createAccount(db, bob.id, { ...sampleAccountInput, email: "bob@example.com" }, key);

    expect(listAccounts(db, alice.id)).toHaveLength(1);
    expect(listAccounts(db, alice.id)[0]!.email).toBe("me@example.com");
  });

  test("finds an account by owning user + email", async () => {
    const db = createTestDb();
    const user = await createUser(db, "alice", "pw");
    const key = deriveEncryptionKey("pw", generateSalt());
    createAccount(db, user.id, sampleAccountInput, key);

    const row = getAccountByEmail(db, user.id, "me@example.com");
    expect(row.email).toBe("me@example.com");
    expect(() => getAccountByEmail(db, user.id, "missing@example.com")).toThrow(ApiError);
  });

  test("updateAccount re-encrypts a changed password with the given key", async () => {
    const db = createTestDb();
    const user = await createUser(db, "alice", "pw");
    const key = deriveEncryptionKey("pw", generateSalt());
    const account = createAccount(db, user.id, sampleAccountInput, key);

    updateAccount(db, account.id, { imapPassword: "new-imap-pw" }, key);
    const row = getAccountRow(db, account.id);
    const creds = decryptAccountCredentials(row, key);

    expect(creds.imapPassword).toBe("new-imap-pw");
    expect(creds.smtpPassword).toBe("smtp-pw"); // untouched
  });

  test("deleteAccount removes the row", async () => {
    const db = createTestDb();
    const user = await createUser(db, "alice", "pw");
    const key = deriveEncryptionKey("pw", generateSalt());
    const account = createAccount(db, user.id, sampleAccountInput, key);

    deleteAccount(db, account.id);
    expect(() => getAccountRow(db, account.id)).toThrow(ApiError);
  });

  describe("readOnly flag", () => {
    test("defaults to false when not given", async () => {
      const db = createTestDb();
      const user = await createUser(db, "alice", "pw");
      const key = deriveEncryptionKey("pw", generateSalt());

      const account = createAccount(db, user.id, sampleAccountInput, key);
      expect(account.readOnly).toBe(false);
    });

    test("is stored when given true at creation", async () => {
      const db = createTestDb();
      const user = await createUser(db, "alice", "pw");
      const key = deriveEncryptionKey("pw", generateSalt());

      const account = createAccount(db, user.id, { ...sampleAccountInput, readOnly: true }, key);
      expect(account.readOnly).toBe(true);
    });

    test("can be toggled via updateAccount without touching other fields", async () => {
      const db = createTestDb();
      const user = await createUser(db, "alice", "pw");
      const key = deriveEncryptionKey("pw", generateSalt());
      const account = createAccount(db, user.id, sampleAccountInput, key);

      const updated = updateAccount(db, account.id, { readOnly: true }, key);
      expect(updated.readOnly).toBe(true);
      expect(updated.imapHost).toBe(sampleAccountInput.imapHost);

      const reverted = updateAccount(db, account.id, { readOnly: false }, key);
      expect(reverted.readOnly).toBe(false);
    });

    test("is preserved across an update that doesn't mention it", async () => {
      const db = createTestDb();
      const user = await createUser(db, "alice", "pw");
      const key = deriveEncryptionKey("pw", generateSalt());
      const account = createAccount(db, user.id, { ...sampleAccountInput, readOnly: true }, key);

      const updated = updateAccount(db, account.id, { displayName: "New name" }, key);
      expect(updated.readOnly).toBe(true);
      expect(updated.displayName).toBe("New name");
    });
  });
});
