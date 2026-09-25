import { Database } from "bun:sqlite";

/**
 * A folder's UIDVALIDITY, as last seen — the number an IMAP server hands out with its UIDs, which changes only if the
 * server has renumbered the folder from scratch (a rebuild, a repair, certain migrations). A UID is only meaningful
 * within one UIDVALIDITY: once it changes, every UID this app has stored for that folder may now refer to a
 * different message, or nothing at all — trusting them regardless (as if nothing had happened) is what let a message
 * that was still genuinely on the server get treated as "gone" and permanently deleted locally (see reconcileExisting
 * in services/sync.ts, which reads this to decide whether its stored UIDs can still be trusted this run).
 */
export function getFolderUidValidity(db: Database, accountId: number, folder: string): number | null {
  return (
    db
      .query<{ uid_validity: number }, [number, string]>("SELECT uid_validity FROM folder_uid_validity WHERE account_id = ? AND folder = ?")
      .get(accountId, folder)?.uid_validity ?? null
  );
}

export function setFolderUidValidity(db: Database, accountId: number, folder: string, uidValidity: number): void {
  db.query(
    "INSERT INTO folder_uid_validity (account_id, folder, uid_validity) VALUES (?, ?, ?) ON CONFLICT (account_id, folder) DO UPDATE SET uid_validity = excluded.uid_validity"
  ).run(accountId, folder, uidValidity);
}
