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

/**
 * The highest UID an actual, complete sync walk of this folder has confirmed — the sync's own "how far have I
 * gotten" watermark, deliberately kept apart from `MAX(emails.uid)` for the folder. See the schema comment on
 * `folder_uid_validity` for why: a row can get a real server UID written to it directly (sending or moving a
 * message) without the folder ever having been walked that far, and trusting that as the watermark would skip
 * over — permanently — any message another mail client appended in between. `null` means never synced.
 */
export function getHighestSyncedUid(db: Database, accountId: number, folder: string): number | null {
  return (
    db
      .query<{ highest_synced_uid: number | null }, [number, string]>("SELECT highest_synced_uid FROM folder_uid_validity WHERE account_id = ? AND folder = ?")
      .get(accountId, folder)?.highest_synced_uid ?? null
  );
}

/** Only ever called from the sync itself (services/sync.ts), with the highest UID a completed walk actually reached. */
export function setHighestSyncedUid(db: Database, accountId: number, folder: string, uid: number): void {
  db.query(
    `INSERT INTO folder_uid_validity (account_id, folder, uid_validity, highest_synced_uid) VALUES (?, ?, 0, ?)
     ON CONFLICT (account_id, folder) DO UPDATE SET highest_synced_uid = excluded.highest_synced_uid`
  ).run(accountId, folder, uid);
}
