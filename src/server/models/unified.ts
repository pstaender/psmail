import { Database } from "bun:sqlite";
import type { EmailAddress } from "../types";
import { emailIdsWithAttachments, taxonomyListsFor } from "./emails";
import type { SearchResult } from "./search";
import { listFilterSql } from "./dateBounds";

/** `imbox` is the important part of the Inbox: the messages the classifier picked (see models/imbox.ts). */
export type UnifiedKind = "inbox" | "sent" | "imbox";

export function isUnifiedKind(value: string): value is UnifiedKind {
  return value === "inbox" || value === "sent" || value === "imbox";
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
export function isNonInboxFolder(folder: string, account: AccountFolders): boolean {
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

/**
 * The folders of an account that the combined Inbox covers: its Inbox — INBOX, or a folder named "inbox" in any case
 * on servers that spell it differently — or, opt-in, every folder that isn't Sent/Drafts/Trash/Junk/Archive.
 */
export function inboxFolders(db: Database, account: AccountFolders, includeFolders: boolean): string[] {
  const folders = db.query<{ folder: string }, [number]>("SELECT DISTINCT folder FROM emails WHERE account_id = ?").all(account.id).map(f => f.folder);
  const inboxes = folders.filter(folder => folder.toLowerCase() === "inbox");
  const base = inboxes.length > 0 ? inboxes : ["INBOX"];
  if (!includeFolders) return base;

  const included = folders.filter(folder => folder.toLowerCase() === "inbox" || !isNonInboxFolder(folder, account));
  return included.length > 0 ? included : base;
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
  options: { limit?: number; offset?: number; includeFolders?: boolean; after?: string; before?: string; categories?: string[] } = {}
): SearchResult[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const accounts = db
    .query<{ id: number; email: string; sent_folder: string | null; special_folders: string | null }, [number]>(
      "SELECT id, email, sent_folder, special_folders FROM accounts WHERE user_id = ?"
    )
    .all(userId);

  // With a date window the same per-folder query just gains range conditions on `date`, still served by the index in order.
  const window = listFilterSql(options);
  const query = db.query<Row, (string | number)[]>(
    // The imbox reads its own partial index (only the important messages, already in date order); left to itself the planner would
    // walk the whole folder's date index and filter, which is fine for a busy imbox and slow for a rare one.
    `SELECT id, folder, uid, is_read, is_flagged, subject, from_addr, to_addr, date FROM emails${kind === "imbox" ? " INDEXED BY idx_emails_imbox" : ""}
     WHERE account_id = ? AND folder = ?${kind === "imbox" ? " AND imbox = 1" : ""}${window.sql} ORDER BY date DESC, id DESC LIMIT ?`
  );

  const merged: (SearchResult & { sortDate: string })[] = [];
  for (const account of accounts) {
    const folders = kind === "sent" ? [sentFolderFor(db, account.id, account.sent_folder)] : inboxFolders(db, account, options.includeFolders ?? false);
    // One index-served query per (account, folder), merged below — see the doc comment above.
    const rows = folders.flatMap(folder => query.all(account.id, folder, ...window.params, offset + limit));
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
  const categories = taxonomyListsFor(db, page.map(r => r.id));
  return page.map(({ sortDate: _sortDate, ...result }) => ({
    ...result,
    hasAttachments: withAttachments.has(result.id),
    ...(categories.has(result.id) ? { taxonomyList: categories.get(result.id) } : {}),
  }));
}

/** Unread messages across every account's Inbox (or, opt-in, its other incoming folders too) — the combined Inbox's badge; with `imbox` the important ones — the Imbox's. */
export function countUnifiedInboxUnread(db: Database, userId: number, options: { includeFolders?: boolean; imbox?: boolean } = {}): number {
  const accounts = db
    .query<AccountFolders, [number]>("SELECT id, sent_folder, special_folders FROM accounts WHERE user_id = ?")
    .all(userId);
  const unread = db.query<{ folder: string; count: number }, [number]>(
    // With `imbox` only the messages classified as important count: the Imbox entry's badge.
    `SELECT folder, COUNT(*) AS count FROM emails WHERE account_id = ? AND is_read = 0${options.imbox ? " AND imbox = 1" : ""} GROUP BY folder`
  );

  let total = 0;
  for (const account of accounts) {
    const covered = new Set(inboxFolders(db, account, options.includeFolders ?? false));
    for (const row of unread.all(account.id)) if (covered.has(row.folder)) total += row.count;
  }
  return total;
}

export interface NewMailPreview {
  id: number;
  accountEmail: string;
  folder: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string | null;
  date: string | null;
  /** The start of the message text (whitespace collapsed) — for the in-app toast, never for browser notifications. */
  snippet: string;
}

export interface NewMailResult {
  /** The highest message id in the database right now: pass it back as `afterId` next time. */
  latestId: number;
  /** How many new messages there are in total (`messages` only holds the newest few). */
  total: number;
  messages: NewMailPreview[];
}

const NEW_MAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SNIPPET_LENGTH = 200;

function makeSnippet(plain: string | null, html: string | null): string {
  let text = plain ?? "";
  if (!text.trim() && html) {
    text = html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH).trimEnd()}…` : text;
}

/**
 * Unread messages that arrived in the combined Inbox after `afterId` (an email id from an earlier
 * call's `latestId`) — what the web client announces after a sync. Ids only ever grow, so "newer than
 * the last id seen" needs no per-client bookkeeping on the server, and the query touches only the
 * handful of rows past that id. Drafts, already-read messages (read on another device), messages
 * outside the combined Inbox's folders, and anything older than a day (the backlog of a first sync)
 * are not "new mail". Without `afterId` it just reports the current `latestId` — the starting point.
 */
export function listNewInboxMail(
  db: Database,
  userId: number,
  afterId: number | null,
  options: { includeFolders?: boolean; limit?: number; now?: number } = {}
): NewMailResult {
  const latestId = db.query<{ id: number }, []>("SELECT COALESCE(MAX(id), 0) AS id FROM emails").get()!.id;
  if (afterId === null || afterId >= latestId) return { latestId, total: 0, messages: [] };

  const accounts = new Map(
    db
      .query<{ id: number; email: string; sent_folder: string | null; special_folders: string | null }, [number]>(
        "SELECT id, email, sent_folder, special_folders FROM accounts WHERE user_id = ?"
      )
      .all(userId)
      .map(account => [account.id, { ...account, folders: new Set<string>() }])
  );
  for (const account of accounts.values()) account.folders = new Set(inboxFolders(db, account, options.includeFolders ?? false));

  const cutoff = new Date((options.now ?? Date.now()) - NEW_MAIL_MAX_AGE_MS).toISOString();
  const candidates = db
    .query<{ id: number; account_id: number; folder: string }, [number, number, string]>(
      `SELECT id, account_id, folder FROM emails
       WHERE id > ? AND id <= ? AND is_read = 0 AND is_draft = 0 AND (date IS NULL OR date >= ?)
       ORDER BY id DESC`
    )
    .all(afterId, latestId, cutoff)
    .filter(row => accounts.get(row.account_id)?.folders.has(row.folder));

  const detail = db.query<
    { from_addr: string | null; to_addr: string | null; cc_addr: string | null; subject: string | null; date: string | null; plain_text: string | null; html_text: string | null },
    [number]
  >(
    `SELECT from_addr, to_addr, cc_addr, subject, date, substr(plain_text, 1, 1000) AS plain_text,
            CASE WHEN plain_text IS NULL OR trim(plain_text) = '' THEN substr(html_text, 1, 20000) END AS html_text
     FROM emails WHERE id = ?`
  );

  const messages = candidates.slice(0, options.limit ?? 5).map(row => {
    const d = detail.get(row.id)!;
    return {
      id: row.id,
      accountEmail: accounts.get(row.account_id)!.email,
      folder: row.folder,
      from: parseAddresses(d.from_addr),
      to: parseAddresses(d.to_addr),
      cc: parseAddresses(d.cc_addr),
      subject: d.subject,
      date: d.date,
      snippet: makeSnippet(d.plain_text, d.html_text),
    };
  });

  return { latestId, total: candidates.length, messages };
}
