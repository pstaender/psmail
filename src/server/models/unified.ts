import { Database } from "bun:sqlite";
import type { EmailAddress } from "../types";
import { emailIdsWithAttachments } from "./emails";
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

/** Names servers give folders that aren't "incoming mail" — the fallback for accounts whose special folders haven't been learned (see learnSpecialFolders). */
const NON_INBOX_FOLDER_NAMES = new Set([
  ...SENT_FOLDER_NAMES,
  "drafts", "draft", "entwürfe", "entwurf", "trash", "deleted items", "deleted messages", "deleted", "papierkorb", "gelöscht", "gelöschte elemente",
  "junk", "junk e-mail", "junk-e-mail", "junk email", "spam", "bulk mail", "archive", "archiv", "archives",
]);

interface AccountFolders {
  id: number;
  sent_folder: string | null;
  special_folders: string | null;
}

/** True for a folder that holds something other than incoming mail (Sent, Drafts, Trash, Junk, Archive), by learned path or by common name. */
function isNonInboxFolder(folder: string, account: AccountFolders): boolean {
  const learned = new Set<string>();
  if (account.sent_folder) learned.add(account.sent_folder);
  try {
    for (const path of Object.values(JSON.parse(account.special_folders ?? "{}"))) if (typeof path === "string") learned.add(path);
  } catch {}
  if (learned.has(folder)) return true;
  const lower = folder.toLowerCase();
  const lastSegment = lower.split(/[/.]/).pop() ?? lower;
  return NON_INBOX_FOLDER_NAMES.has(lower) || NON_INBOX_FOLDER_NAMES.has(lastSegment);
}

/** The folders of an account that the combined Inbox covers: just INBOX, or — opt-in — every folder that isn't Sent/Drafts/Trash/Junk/Archive. */
function inboxFolders(db: Database, account: AccountFolders, includeFolders: boolean): string[] {
  if (!includeFolders) return ["INBOX"];
  const folders = db.query<{ folder: string }, [number]>("SELECT DISTINCT folder FROM emails WHERE account_id = ?").all(account.id);
  const included = folders.map(f => f.folder).filter(folder => folder === "INBOX" || !isNonInboxFolder(folder, account));
  return included.length > 0 ? included : ["INBOX"];
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
  options: { limit?: number; offset?: number; includeFolders?: boolean } = {}
): SearchResult[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const accounts = db
    .query<{ id: number; email: string; sent_folder: string | null; special_folders: string | null }, [number]>(
      "SELECT id, email, sent_folder, special_folders FROM accounts WHERE user_id = ?"
    )
    .all(userId);

  const query = db.query<Row, [number, string, number]>(
    `SELECT id, folder, uid, is_read, is_flagged, subject, from_addr, to_addr, date FROM emails
     WHERE account_id = ? AND folder = ? ORDER BY date DESC, id DESC LIMIT ?`
  );

  const merged: (SearchResult & { sortDate: string })[] = [];
  for (const account of accounts) {
    const folders = kind === "inbox" ? inboxFolders(db, account, options.includeFolders ?? false) : [sentFolderFor(db, account.id, account.sent_folder)];
    // One index-served query per (account, folder), merged below — see the doc comment above.
    const rows = folders.flatMap(folder => query.all(account.id, folder, offset + limit));
    for (const row of rows) {
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
  const page = merged.slice(offset, offset + limit);
  const withAttachments = emailIdsWithAttachments(db, page.map(r => r.id));
  return page.map(({ sortDate: _sortDate, ...result }) => ({ ...result, hasAttachments: withAttachments.has(result.id) }));
}

/** Unread messages across every account's Inbox (or, opt-in, its other incoming folders too) — the combined Inbox's badge. */
export function countUnifiedInboxUnread(db: Database, userId: number, options: { includeFolders?: boolean } = {}): number {
  const accounts = db
    .query<AccountFolders, [number]>("SELECT id, sent_folder, special_folders FROM accounts WHERE user_id = ?")
    .all(userId);
  const unread = db.query<{ folder: string; count: number }, [number]>(
    "SELECT folder, COUNT(*) AS count FROM emails WHERE account_id = ? AND is_read = 0 GROUP BY folder"
  );

  let total = 0;
  for (const account of accounts) {
    const covered = new Set(inboxFolders(db, account, options.includeFolders ?? false));
    for (const row of unread.all(account.id)) if (covered.has(row.folder)) total += row.count;
  }
  return total;
}
