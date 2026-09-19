import { Database } from "bun:sqlite";
import { hashPassword, verifyPassword } from "../crypto/password";
import { decryptSecret, deriveEncryptionKey, encryptSecret, generateSalt } from "../crypto/secrets";
import { ApiError, ConflictError, NotFoundError, UnauthorizedError, type User } from "../types";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  password_salt: string;
  auth_method: string;
  created_at: string;
  updated_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    authMethod: row.auth_method,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createUser(db: Database, username: string, password: string): Promise<User> {
  const existing = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) throw new ConflictError(`Username "${username}" already exists`);

  const salt = generateSalt();
  const passwordHash = await hashPassword(password);

  const row = db
    .query<UserRow, [string, string, string]>(
      `INSERT INTO users (username, password_hash, password_salt)
       VALUES (?, ?, ?)
       RETURNING *`
    )
    .get(username, passwordHash, salt);

  return toUser(row!);
}

export function listUsers(db: Database): User[] {
  const rows = db.query<UserRow, []>("SELECT * FROM users ORDER BY id").all();
  return rows.map(toUser);
}

export function getUser(db: Database, id: number): User {
  const row = db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) throw new NotFoundError(`User ${id} not found`);
  return toUser(row);
}

export function getUserRowByUsername(db: Database, username: string): UserRow | null {
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE username = ?").get(username);
}

export function getUserRowById(db: Database, id: number): UserRow | null {
  return db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(id);
}

/**
 * Changes a user's login password — which also changes the key their accounts' IMAP/SMTP passwords are
 * encrypted with (derived from the password and a salt, see crypto/secrets.ts). So every account secret
 * is decrypted with the current key (`oldKey`, from the caller's session) and re-encrypted with the key
 * for the new password and a fresh salt, all in one transaction together with the new hash: either
 * everything changes or nothing does, and an account whose secrets can't be decrypted stops the change
 * instead of being silently stranded. Returns the new key for the caller's session.
 */
export async function changeUserPassword(
  db: Database,
  id: number,
  currentPassword: string,
  newPassword: string,
  oldKey: Buffer
): Promise<Buffer> {
  const existing = getUserRowById(db, id);
  if (!existing) throw new NotFoundError(`User ${id} not found`);
  if (!(await verifyPassword(currentPassword, existing.password_hash))) throw new UnauthorizedError("Current password is incorrect");

  const newSalt = generateSalt();
  const newKey = deriveEncryptionKey(newPassword, newSalt);
  const newHash = await hashPassword(newPassword);

  db.transaction(() => {
    const accounts = db
      .query<{ id: number; email: string; imap_password_encrypted: string; smtp_password_encrypted: string }, [number]>(
        "SELECT id, email, imap_password_encrypted, smtp_password_encrypted FROM accounts WHERE user_id = ?"
      )
      .all(id);

    const update = db.query("UPDATE accounts SET imap_password_encrypted = ?, smtp_password_encrypted = ? WHERE id = ?");
    for (const account of accounts) {
      let imap: string;
      let smtp: string;
      try {
        imap = decryptSecret(account.imap_password_encrypted, oldKey);
        smtp = decryptSecret(account.smtp_password_encrypted, oldKey);
      } catch {
        throw new ApiError(
          422,
          `The saved passwords of account "${account.email}" can't be decrypted, so they can't be carried over to the new password. Re-enter them in that account's settings first, then change your password.`
        );
      }
      update.run(encryptSecret(imap, newKey), encryptSecret(smtp, newKey), account.id);
    }

    // The AI API keys are encrypted with the same key, so they move along with the account passwords.
    const apis = db
      .query<{ id: number; name: string; api_key_encrypted: string }, [number]>(
        "SELECT id, name, api_key_encrypted FROM ai_apis WHERE user_id = ? AND api_key_encrypted IS NOT NULL"
      )
      .all(id);
    const updateApi = db.query("UPDATE ai_apis SET api_key_encrypted = ? WHERE id = ?");
    for (const api of apis) {
      let apiKey: string;
      try {
        apiKey = decryptSecret(api.api_key_encrypted, oldKey);
      } catch {
        throw new ApiError(
          422,
          `The saved API key of the AI API "${api.name}" can't be decrypted, so it can't be carried over to the new password. Re-enter it in Settings → AI first, then change your password.`
        );
      }
      updateApi.run(encryptSecret(apiKey, newKey), api.id);
    }

    db.query(
      `UPDATE users SET password_hash = ?, password_salt = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    ).run(newHash, newSalt, id);
  })();

  return newKey;
}

export function deleteUser(db: Database, id: number): void {
  const result = db.query("DELETE FROM users WHERE id = ?").run(id);
  if (result.changes === 0) throw new NotFoundError(`User ${id} not found`);
}

export async function verifyUserPassword(db: Database, username: string, password: string): Promise<UserRow> {
  const row = getUserRowByUsername(db, username);
  if (!row) throw new NotFoundError(`User "${username}" not found`);

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) throw new UnauthorizedError("Invalid credentials");

  return row;
}

/** Ensures the built-in default user (empty password) exists. */
export async function ensureDefaultUser(db: Database): Promise<User> {
  const existing = getUserRowByUsername(db, "default");
  if (existing) return toUser(existing);
  return createUser(db, "default", "");
}
