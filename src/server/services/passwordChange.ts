import type { Database } from "bun:sqlite";
import { changeUserPassword } from "../models/users";
import { destroyOtherSessions, setSessionEncryptionKey } from "./sessions";

/**
 * Changes the password of the user behind `session`: re-encrypts their account secrets (see
 * changeUserPassword), gives the current session the new key so it keeps working, and signs the user out
 * of every other session (their keys are stale). Returns how many other sessions were ended.
 */
export async function changePasswordForSession(
  db: Database,
  session: { token: string; userId: number },
  oldKey: Buffer,
  currentPassword: string,
  newPassword: string
): Promise<{ otherSessionsSignedOut: number }> {
  const newKey = await changeUserPassword(db, session.userId, currentPassword, newPassword, oldKey);
  setSessionEncryptionKey(session.token, newKey);
  return { otherSessionsSignedOut: destroyOtherSessions(db, session.userId, session.token) };
}
