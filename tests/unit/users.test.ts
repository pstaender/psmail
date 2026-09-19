import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import {
  createUser,
  deleteUser,
  ensureDefaultUser,
  getUser,
  listUsers,
  changeUserPassword,
  verifyUserPassword,
} from "../../src/server/models/users";
import { ApiError } from "../../src/server/types";
import { decryptSecret, deriveEncryptionKey } from "../../src/server/crypto/secrets";
import { createAccount, getAccountRow } from "../../src/server/models/accounts";

describe("users model", () => {
  test("creates a user and lists it", async () => {
    const db = createTestDb();
    const user = await createUser(db, "alice", "hunter2");

    expect(user.username).toBe("alice");
    expect(listUsers(db).map(u => u.username)).toEqual(["alice"]);
  });

  test("rejects duplicate usernames", async () => {
    const db = createTestDb();
    await createUser(db, "alice", "pw");
    await expect(createUser(db, "alice", "other")).rejects.toThrow(ApiError);
  });

  test("ensureDefaultUser creates 'default' with an empty password exactly once", async () => {
    const db = createTestDb();
    const first = await ensureDefaultUser(db);
    const second = await ensureDefaultUser(db);

    expect(first.id).toBe(second.id);
    expect(first.username).toBe("default");
    expect(listUsers(db)).toHaveLength(1);

    const verified = await verifyUserPassword(db, "default", "");
    expect(verified.username).toBe("default");
  });

  test("verifyUserPassword rejects wrong password", async () => {
    const db = createTestDb();
    await createUser(db, "bob", "correct-password");
    await expect(verifyUserPassword(db, "bob", "wrong-password")).rejects.toThrow(ApiError);
  });

  async function userWithAccount(password: string) {
    const db = createTestDb();
    const user = await createUser(db, "carol", password);
    const salt = db.query<{ password_salt: string }, [number]>("SELECT password_salt FROM users WHERE id = ?").get(user.id)!.password_salt;
    const key = deriveEncryptionKey(password, salt);
    const account = createAccount(
      db,
      user.id,
      {
        email: "me@example.com", imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: "me", imapPassword: "imap-secret",
        smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: "me", smtpPassword: "smtp-secret",
      },
      key
    );
    return { db, user, key, account };
  }

  test("changeUserPassword swaps the login password and re-encrypts the accounts' saved passwords with a new key and salt", async () => {
    const { db, user, key, account } = await userWithAccount("old-pw");
    const before = db.query<{ password_salt: string }, [number]>("SELECT password_salt FROM users WHERE id = ?").get(user.id)!;

    const newKey = await changeUserPassword(db, user.id, "old-pw", "new-pw", key);

    await expect(verifyUserPassword(db, "carol", "old-pw")).rejects.toThrow();
    await expect(verifyUserPassword(db, "carol", "new-pw")).resolves.toBeTruthy();

    const after = db.query<{ password_salt: string }, [number]>("SELECT password_salt FROM users WHERE id = ?").get(user.id)!;
    expect(after.password_salt).not.toBe(before.password_salt);
    expect(newKey.equals(deriveEncryptionKey("new-pw", after.password_salt))).toBe(true);

    const row = getAccountRow(db, account.id);
    expect(decryptSecret(row.imap_password_encrypted, newKey)).toBe("imap-secret");
    expect(decryptSecret(row.smtp_password_encrypted, newKey)).toBe("smtp-secret");
    expect(() => decryptSecret(row.imap_password_encrypted, key)).toThrow(); // the old key no longer opens them
  });

  test("changeUserPassword needs the right current password and changes nothing without it", async () => {
    const { db, user, key, account } = await userWithAccount("old-pw");
    const rowBefore = getAccountRow(db, account.id);

    await expect(changeUserPassword(db, user.id, "wrong", "new-pw", key)).rejects.toThrow(/Current password is incorrect/);

    await expect(verifyUserPassword(db, "carol", "old-pw")).resolves.toBeTruthy();
    expect(getAccountRow(db, account.id).imap_password_encrypted).toBe(rowBefore.imap_password_encrypted);
  });

  test("changeUserPassword is all-or-nothing: an account that can't be decrypted stops the change", async () => {
    const { db, user, key, account } = await userWithAccount("old-pw");
    const second = createAccount(
      db,
      user.id,
      {
        email: "other@example.com", imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: "o", imapPassword: "x",
        smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: "o", smtpPassword: "y",
      },
      deriveEncryptionKey("some-other-password", "00".repeat(16)) // encrypted under a key the session doesn't have
    );

    await expect(changeUserPassword(db, user.id, "old-pw", "new-pw", key)).rejects.toThrow(/other@example.com/);

    await expect(verifyUserPassword(db, "carol", "old-pw")).resolves.toBeTruthy(); // password unchanged
    expect(decryptSecret(getAccountRow(db, account.id).imap_password_encrypted, key)).toBe("imap-secret"); // first account rolled back too
    expect(second.id).toBeGreaterThan(0);
  });

  test("the passwordless default user can set a password", async () => {
    const { db, user, key } = await userWithAccount("");
    await changeUserPassword(db, user.id, "", "brand-new", key);
    await expect(verifyUserPassword(db, "carol", "")).rejects.toThrow();
    await expect(verifyUserPassword(db, "carol", "brand-new")).resolves.toBeTruthy();
  });

  test("getUser throws for unknown id", () => {
    const db = createTestDb();
    expect(() => getUser(db, 999)).toThrow(ApiError);
  });

  test("deleteUser removes the row", async () => {
    const db = createTestDb();
    const user = await createUser(db, "dave", "pw");
    deleteUser(db, user.id);
    expect(() => getUser(db, user.id)).toThrow(ApiError);
  });
});
