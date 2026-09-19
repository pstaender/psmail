import { Database } from "bun:sqlite";
import type { EmailAddress } from "../types";
import type { SearchResult } from "./search";

export type UnifiedKind = "inbox" | "sent";

export function isUnifiedKind(value: string): value is UnifiedKind {
  return value === "inbox" || value === "sent";
}

/** Names servers commonly give the Sent folder — the fallback for an account whose real path hasn't been learned yet (see setSentFolder). */
const SENT_FOLDER_NAMES = new Set([
  "sent", "sent items", "sent mail", "sent messages", "gesendet", "gesendete elemente", "gesendete objekte", "gesendete nachrichten",
  "inbox.sent", "inbox/sent", "[gmail]/sent mail",
]);

interface Row {
  id: number;
  folder: string;
  uid: number | null;
  is_read: number;
  is_flagged: number;
  subject: string | null;
  from_addr: string | null;
  to_addr: string | null;
  date: string | null;
}

function parseAddresses(json: string | null): EmailAddress[] {
  try {
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
}

function sentFolderFor(db: Database, accountId: number, learned: string | null): string {
  if (learned) return learned;
  const folders = db.query<{ folder: string }, [number]>("SELECT DISTINCT folder FROM emails WHERE account_id = ?").all(accountId);
  return folders.find(f => SENT_FOLDER_NAMES.has(f.folder.toLowerCase()))?.folder ?? "Sent";
}

/**
 * One newest-first list across all of a user's accounts: every account's Inbox (`inbox`) or Sent
 * folder (`sent`). Each account is queried on its own — straight off the (account, folder, date, id)
 * index, fetching only offset+limit rows — and the small per-account lists are merged, which stays
 * fast however large the mailboxes are (a single cross-account ORDER BY couldn't use that index).
 */
export function listUnifiedEmails(
  db: Database,
  userId: number,
  kind: UnifiedKind,
  options: { limit?: number; offset?: number } = {}
): SearchResult[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const accounts = db
    .query<{ id: number; email: string; sent_folder: string | null }, [number]>(
      "SELECT id, email, sent_folder FROM accounts WHERE user_id = ?"
    )
    .all(userId);

  const query = db.query<Row, [number, string, number]>(
    `SELECT id, folder, uid, is_read, is_flagged, subject, from_addr, to_addr, date FROM emails
     WHERE account_id = ? AND folder = ? ORDER BY date DESC, id DESC LIMIT ?`
  );

  const merged: (SearchResult & { sortDate: string })[] = [];
  for (const account of accounts) {
    const folder = kind === "inbox" ? "INBOX" : sentFolderFor(db, account.id, account.sent_folder);
    for (const row of query.all(account.id, folder, offset + limit)) {
      merged.push({
        id: row.id,
        accountEmail: account.email,
        folder: row.folder,
        uid: row.uid,
        isRead: !!row.is_read,
        isFlagged: !!row.is_flagged,
        subject: row.subject,
        from: parseAddresses(row.from_addr),
        ...(kind === "sent" ? { to: parseAddresses(row.to_addr) } : {}),
        date: row.date,
        sortDate: row.date ?? "",
      });
    }
  }

  merged.sort((a, b) => (a.sortDate === b.sortDate ? b.id - a.id : a.sortDate < b.sortDate ? 1 : -1));
  return merged.slice(offset, offset + limit).map(({ sortDate: _sortDate, ...result }) => result);
}
