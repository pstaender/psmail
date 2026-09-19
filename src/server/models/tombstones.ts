import { Database } from "bun:sqlite";

/**
 * Remembers that a message with this UID was deleted (or moved away) locally without the server
 * being told — which is what happens in a read-only account. Without this, the next sync would
 * fetch it again: a deleted highest UID drops the "newer than" watermark back below it.
 *
 * A separate table rather than a "deleted" flag on the email row because the row (bodies, headers,
 * attachments) should really go — and because a flag would have to be filtered out of every list,
 * search, count and contact query, where one missed spot resurrects deleted mail in the UI.
 */
export function addDeletedUid(db: Database, accountId: number, folder: string, uid: number): void {
  db.query("INSERT OR IGNORE INTO deleted_uids (account_id, folder, uid) VALUES (?, ?, ?)").run(accountId, folder, uid);
}

export function listDeletedUids(db: Database, accountId: number, folder: string): number[] {
  return db
    .query<{ uid: number }, [number, string]>("SELECT uid FROM deleted_uids WHERE account_id = ? AND folder = ?")
    .all(accountId, folder)
    .map(row => row.uid);
}

export function isUidDeleted(db: Database, accountId: number, folder: string, uid: number): boolean {
  return !!db.query("SELECT 1 FROM deleted_uids WHERE account_id = ? AND folder = ? AND uid = ?").get(accountId, folder, uid);
}

/** The highest tombstoned UID in the folder (0 if none) — part of the sync watermark, alongside the highest stored UID. */
export function maxDeletedUid(db: Database, accountId: number, folder: string): number {
  return (
    db
      .query<{ max_uid: number | null }, [number, string]>("SELECT MAX(uid) AS max_uid FROM deleted_uids WHERE account_id = ? AND folder = ?")
      .get(accountId, folder)?.max_uid ?? 0
  );
}

export function removeDeletedUids(db: Database, accountId: number, folder: string, uids: number[]): void {
  const stmt = db.query("DELETE FROM deleted_uids WHERE account_id = ? AND folder = ? AND uid = ?");
  db.transaction(() => {
    for (const uid of uids) stmt.run(accountId, folder, uid);
  })();
}
