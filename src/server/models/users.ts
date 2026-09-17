import { Database } from "bun:sqlite";
import { hashPassword, verifyPassword } from "../crypto/password";
import { generateSalt } from "../crypto/secrets";
import { ConflictError, NotFoundError, UnauthorizedError, type User } from "../types";

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

export async function updateUserPassword(db: Database, id: number, newPassword: string): Promise<User> {
  const existing = getUserRowById(db, id);
  if (!existing) throw new NotFoundError(`User ${id} not found`);

  const passwordHash = await hashPassword(newPassword);
  const row = db
    .query<UserRow, [string, number]>(
      `UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
       RETURNING *`
    )
    .get(passwordHash, id);

  return toUser(row!);
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
