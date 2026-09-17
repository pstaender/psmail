import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { loadSettings } from "../config/settings";

export interface Session {
  token: string;
  userId: number;
  expiresAt: string;
}

/**
 * The per-session encryption key (derived from the user's login password) is
 * kept ONLY in process memory, never persisted — restarting the server
 * invalidates the ability to decrypt account secrets until the user logs in
 * again, even though the session row itself may still be valid.
 */
const keyCache = new Map<string, Buffer>();

export async function createSession(db: Database, userId: number, encryptionKey: Buffer): Promise<Session> {
  const settings = await loadSettings();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + settings.sessionTtlSeconds * 1000).toISOString();

  db.query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expiresAt);
  keyCache.set(token, encryptionKey);

  return { token, userId, expiresAt };
}

export function getSession(db: Database, token: string): Session | null {
  const row = db
    .query<{ token: string; user_id: number; expires_at: string }, [string]>(
      "SELECT token, user_id, expires_at FROM sessions WHERE token = ?"
    )
    .get(token);

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(db, token);
    return null;
  }

  return { token: row.token, userId: row.user_id, expiresAt: row.expires_at };
}

export function getSessionEncryptionKey(token: string): Buffer | null {
  return keyCache.get(token) ?? null;
}

export function destroySession(db: Database, token: string): void {
  db.query("DELETE FROM sessions WHERE token = ?").run(token);
  keyCache.delete(token);
}

export function clearKeyCache(): void {
  keyCache.clear();
}
