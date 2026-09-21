import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { EmailAddress } from "../types";
import { NotFoundError } from "../types";
import { classify, domainOf, registrableDomain, type Classification, type ImboxFacts, type ImboxMessage } from "../services/imbox/classifier";
import { inboxFolders, isNonInboxFolder } from "./unified";

/**
 * The mailbox side of the imbox: what the classifier (services/imbox/classifier.ts) needs to know about a message that isn't in the
 * message — who the user has written to, what was received from the sender before and where it ended up, whether the message answers
 * one of the user's — and the storing of the verdict in `emails.imbox` (1 important, 0 not, NULL not classified yet).
 */

interface AccountInfo {
  id: number;
  email: string;
  display_name: string | null;
  sender_name: string | null;
  sent_folder: string | null;
  special_folders: string | null;
}

interface MessageRow {
  id: number;
  account_id: number;
  folder: string;
  from_addr: string | null;
  to_addr: string | null;
  cc_addr: string | null;
  reply_to_addr: string | null;
  subject: string | null;
  in_reply_to: string | null;
  authentication_results: string | null;
  spf: string | null;
  headers_raw: string | null;
  is_read: number;
  is_flagged: number;
  imbox_manual: number;
  /** Path of a calendar file (.ics / text/calendar) attached to the message, if any. */
  ics_path: string | null;
  ics_count: number;
  plain: string | null;
  html: string | null;
  attachment_names: string | null;
}

const JUNK_NAMES = new Set(["junk", "junk e-mail", "junk-e-mail", "junk email", "spam", "bulk mail", "bulk", "[gmail]/spam", "inbox.junk", "inbox.spam", "unerwünscht"]);

const parseAddresses = (json: string | null): EmailAddress[] => {
  try {
    const parsed = json ? JSON.parse(json) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** Junk/Spam folder: the path the server said is the junk folder, or a folder that is called that. */
export function isJunkFolder(folder: string, account: Pick<AccountInfo, "special_folders">): boolean {
  try {
    const learned = JSON.parse(account.special_folders ?? "{}")?.junk;
    if (typeof learned === "string" && learned === folder) return true;
  } catch {
    // an unreadable remembered list: the names still work
  }
  const lower = folder.toLowerCase();
  return JUNK_NAMES.has(lower) || JUNK_NAMES.has(lower.split(/[/.]/).pop() ?? lower);
}

const TRASH_NAMES = new Set(["trash", "deleted items", "deleted messages", "deleted", "papierkorb", "gelöscht", "gelöschte elemente", "gelöschte objekte", "[gmail]/trash", "inbox.trash"]);

/** Trash folder: the learned path, or a folder that is called that. */
export function isTrashFolder(folder: string, account: Pick<AccountInfo, "special_folders">): boolean {
  try {
    const learned = JSON.parse(account.special_folders ?? "{}")?.trash;
    if (typeof learned === "string" && learned === folder) return true;
  } catch {
    // an unreadable remembered list: the names still work
  }
  const lower = folder.toLowerCase();
  return TRASH_NAMES.has(lower) || TRASH_NAMES.has(lower.split(/[/.]/).pop() ?? lower);
}

/** Free-mail providers: an address there says nothing about an organisation. */
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.de", "icloud.com", "me.com", "mac.com",
  "gmx.de", "gmx.net", "gmx.com", "web.de", "t-online.de", "freenet.de", "mailbox.org", "posteo.de", "posteo.net", "proton.me", "protonmail.com", "pm.me",
  "aol.com", "arcor.de", "online.de", "hey.com", "fastmail.com", "zoho.com", "mail.com", "yandex.com",
]);

/**
 * The shape of a subject: lower case, digits as #, quoted or bracketed parts and long code-like words dropped — so "Your order 4711 has
 * shipped" and "Your order 4712 has shipped" are the same shape, and a sender whose subjects are mostly one shape is a machine.
 */
export function subjectShape(subject: string | null): string {
  return (subject ?? "")
    .toLowerCase()
    .replace(/^(re|aw|fw|fwd|wg)\s*:\s*/g, "")
    .replace(/["'„“”‚‘’][^"'„“”‚‘’]*["'„“”‚‘’]/g, " ")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b[a-z0-9]{12,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/[^\p{L}#]+/gu, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
}

/** Where classified messages live: incoming folders (Inbox and the like) — not Sent, Drafts, Trash, Junk or Archive. */
export function isImboxFolder(folder: string, account: AccountInfo): boolean {
  return folder.toLowerCase() === "inbox" || (!isNonInboxFolder(folder, account) && !isJunkFolder(folder, account));
}

type FolderKind = "good" | "junk" | "trash" | "other";

const STOP_WORDS = new Set(["info", "mail", "admin", "office", "noreply", "contact", "kontakt", "team", "support", "hello", "service", "post", "the", "und", "and", "web", "user"]);

/** Words the user is greeted with, from the names of their accounts: "Philipp Staender", philipp.staender@… → philipp, staender. */
function namesOf(accounts: AccountInfo[]): string[] {
  const names = new Set<string>();
  for (const account of accounts) {
    const sources = [account.display_name ?? "", account.sender_name ?? "", account.email.split("@")[0] ?? ""];
    for (const source of sources) {
      for (const word of source.toLowerCase().split(/[^\p{L}]+/u)) if (word.length >= 3 && !STOP_WORDS.has(word)) names.add(word);
    }
  }
  return [...names];
}

const MESSAGE_COLUMNS = `e.id, e.account_id, e.folder, e.from_addr, e.to_addr, e.cc_addr, e.reply_to_addr, e.subject, e.in_reply_to,
  e.authentication_results, e.spf, e.headers_raw, e.is_read, e.is_flagged, e.imbox_manual,
  (SELECT file_path FROM attachments WHERE email_id = e.id AND (lower(coalesce(content_type, '')) LIKE 'text/calendar%' OR lower(filename) LIKE '%.ics') LIMIT 1) AS ics_path,
  (SELECT COUNT(*) FROM attachments WHERE email_id = e.id AND (lower(coalesce(content_type, '')) LIKE 'text/calendar%' OR lower(filename) LIKE '%.ics')) AS ics_count,
  substr(e.plain_text, 1, 30000) AS plain, substr(e.html_text, 1, 200000) AS html,
  (SELECT group_concat(filename, char(31)) FROM attachments WHERE email_id = e.id AND is_inline = 0) AS attachment_names`;

/** Message ids a message replies to: In-Reply-To and References, the newest few. */
function referencedIds(row: MessageRow): string[] {
  const unfolded = (row.headers_raw ?? "").replace(/\r?\n[ \t]+/g, " ");
  const references = /^references:[ \t]*(.*)$/im.exec(unfolded)?.[1] ?? "";
  const ids = [...(row.in_reply_to ?? "").matchAll(/<[^<>\s]+>/g), ...references.matchAll(/<[^<>\s]+>/g)].map(match => match[0]);
  return [...new Set(ids)].slice(-10);
}

export interface ImboxContext {
  /** Classifies a stored message (without saving the verdict). */
  classifyRow(row: MessageRow): Classification;
  /** Tells the context about a message that was stored after it was built, so later messages see it in the sender's history. */
  noteStored(row: MessageRow): void;
}

interface SenderStats {
  good: number;
  junk: number;
  trash: number;
  /** Of the `good` messages: read, starred. */
  read: number;
  flagged: number;
  /** All the sender's messages (good, junk, trash) and how many of them have each subject shape. */
  total: number;
  shapes: Map<string, number>;
}

/**
 * Everything the classifier needs about this user's mailbox, read once: the user's own addresses, names and organisation domains, who
 * they have written to (the contact list's sent counts), what they said by hand about senders (the feedback marks), and — from one pass
 * over the stored mail — for every sender address: how many earlier messages are in normal folders, in Junk, in Trash, how many were
 * read or starred, and how the subjects look. Build it once per batch (a sync run, the CLI); one message at a time is then cheap.
 */
export function createImboxContext(db: Database, userId: number): ImboxContext {
  const accounts = db
    .query<AccountInfo, [number]>("SELECT id, email, display_name, sender_name, sent_folder, special_folders FROM accounts WHERE user_id = ?")
    .all(userId);
  const byId = new Map(accounts.map(account => [account.id, account]));
  const ownAddresses = new Set(accounts.map(account => account.email.toLowerCase()));
  const ownNames = namesOf(accounts);
  const accountIds = accounts.map(account => account.id);
  const ownDomains = new Set(
    accounts.map(account => registrableDomain(domainOf(account.email.toLowerCase()))).filter(domain => domain && !FREEMAIL.has(domain))
  );

  const sentTo = new Map<string, number>();
  for (const row of db
    .query<{ address: string; n: number }, [number]>(
      `SELECT c.address AS address, SUM(c.sent_count) AS n FROM contacts c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? GROUP BY c.address HAVING n > 0`
    )
    .all(userId)) {
    sentTo.set(row.address.toLowerCase(), row.n);
  }

  const feedback = new Map<string, { important: number; notImportant: number; last: boolean | null }>();
  for (const row of db
    .query<{ address: string; important: number; not_important: number; last_verdict: number | null }, [number]>(
      "SELECT address, important, not_important, last_verdict FROM imbox_feedback WHERE user_id = ?"
    )
    .all(userId)) {
    feedback.set(row.address, { important: row.important, notImportant: row.not_important, last: row.last_verdict === null ? null : !!row.last_verdict });
  }

  const kindCache = new Map<string, FolderKind>();
  const kindOf = (accountId: number, folder: string): FolderKind => {
    const key = `${accountId}\u0000${folder}`;
    let kind = kindCache.get(key);
    if (!kind) {
      const account = byId.get(accountId);
      kind = !account
        ? "other"
        : isJunkFolder(folder, account)
          ? "junk"
          : isTrashFolder(folder, account)
            ? "trash"
            : isImboxFolder(folder, account)
              ? "good"
              : "other";
      kindCache.set(key, kind);
    }
    return kind;
  };

  const received = new Map<string, SenderStats>();
  /** Adds (or, with by = -1, takes away) one message to what is known about its sender. */
  const count = (address: string, kind: FolderKind, message: { subject: string | null; is_read: number; is_flagged: number }, by: 1 | -1 = 1) => {
    if (kind === "other" || !address) return;
    let entry = received.get(address);
    if (!entry) received.set(address, (entry = { good: 0, junk: 0, trash: 0, read: 0, flagged: 0, total: 0, shapes: new Map() }));
    entry[kind] += by;
    entry.total += by;
    if (kind === "good") {
      entry.read += message.is_read ? by : 0;
      entry.flagged += message.is_flagged ? by : 0;
    }
    const shape = subjectShape(message.subject);
    entry.shapes.set(shape, (entry.shapes.get(shape) ?? 0) + by);
  };
  for (const row of db
    .query<{ account_id: number; folder: string; from_addr: string | null; subject: string | null; is_read: number; is_flagged: number }, [number]>(
      `SELECT e.account_id, e.folder, e.from_addr, e.subject, e.is_read, e.is_flagged FROM emails e JOIN accounts a ON a.id = e.account_id WHERE a.user_id = ? AND e.is_draft = 0`
    )
    .all(userId)) {
    const kind = kindOf(row.account_id, row.folder);
    if (kind !== "other") count((parseAddresses(row.from_addr)[0]?.address ?? "").toLowerCase(), kind, row);
  }

  const idQuery = (n: number) => `SELECT from_addr FROM emails WHERE message_id IN (${Array(n).fill("?").join(",")}) AND account_id IN (${accountIds.join(",") || "0"})`;

  function factsFor(row: MessageRow): ImboxFacts {
    const sender = (parseAddresses(row.from_addr)[0]?.address ?? "").toLowerCase();
    const kind = kindOf(row.account_id, row.folder);
    const stats = received.get(sender);
    const ids = referencedIds(row);
    const threadReply =
      ids.length > 0 &&
      db
        .query<{ from_addr: string | null }, string[]>(idQuery(ids.length))
        .all(...ids)
        .some(other => ownAddresses.has((parseAddresses(other.from_addr)[0]?.address ?? "").toLowerCase()));
    // The message itself is part of the counts (it is stored); it is not an *earlier* one.
    const own = kind === "good";
    const good = Math.max((stats?.good ?? 0) - (own ? 1 : 0), 0);
    return {
      ownAddresses,
      ownNames,
      ownDomains,
      sender: {
        sentTo: sentTo.get(sender) ?? 0,
        receivedGood: good,
        receivedJunk: Math.max((stats?.junk ?? 0) - (kind === "junk" ? 1 : 0), 0),
        readEarlier: Math.min(Math.max((stats?.read ?? 0) - (own && row.is_read ? 1 : 0), 0), good),
        flaggedEarlier: Math.min(Math.max((stats?.flagged ?? 0) - (own && row.is_flagged ? 1 : 0), 0), good),
        trashedEarlier: Math.max((stats?.trash ?? 0) - (kind === "trash" ? 1 : 0), 0),
        feedback: feedback.get(sender),
        lookAlike: stats ? { same: stats.shapes.get(subjectShape(row.subject)) ?? 0, total: stats.total } : undefined,
      },
      threadReply,
      inJunkFolder: kind === "junk",
    };
  }

  return {
    classifyRow: row => classify(toMessage(row), factsFor(row)),
    noteStored: row => count((parseAddresses(row.from_addr)[0]?.address ?? "").toLowerCase(), kindOf(row.account_id, row.folder), row),
  };
}

function toMessage(row: MessageRow): ImboxMessage {
  return {
    from: parseAddresses(row.from_addr),
    to: parseAddresses(row.to_addr),
    cc: parseAddresses(row.cc_addr),
    replyTo: parseAddresses(row.reply_to_addr),
    subject: row.subject,
    plainText: row.plain,
    htmlText: row.html,
    headersRaw: row.headers_raw,
    authenticationResults: row.authentication_results,
    spf: row.spf,
    attachmentNames: row.attachment_names ? row.attachment_names.split("\u001f") : [],
    calendarMethod: calendarMethodOf(row),
  };
}

/** The iCalendar METHOD of the message's calendar file (REQUEST, CANCEL, ...), "" when there is one that can't be read, null when there is none. */
function calendarMethodOf(row: MessageRow): string | null {
  if (!row.ics_count) return null;
  try {
    if (row.ics_path && existsSync(row.ics_path) && statSync(row.ics_path).size < 500_000) {
      return /^METHOD:\s*([A-Za-z-]+)/im.exec(readFileSync(row.ics_path, "utf8").slice(0, 50_000))?.[1]?.toUpperCase() ?? "";
    }
  } catch {
    // an unreadable file still tells us there was an invitation
  }
  return "";
}

/** Stores a verdict (or null: back to "not classified"). */
export function setImbox(db: Database, emailId: number, value: boolean | null): void {
  db.query("UPDATE emails SET imbox = ? WHERE id = ?").run(value === null ? null : value ? 1 : 0, emailId);
}

/**
 * The user's own verdict on a message: `true` (important), `false` (not important), or `null` to take it back (the message is then
 * classified by the classifier again). It is stored on the message and never overwritten by a later classification, and it counts as
 * one vote about the sender's address: the classifier weighs the sender's latest vote above every other signal, so mail that arrives
 * later from the same address follows what the user said. A message carries one vote — marking it again replaces its earlier one.
 */
export function setImboxByHand(db: Database, userId: number, emailId: number, value: boolean | null): void {
  const row = db.query<{ imbox: number | null; imbox_manual: number; from_addr: string | null }, [number]>("SELECT imbox, imbox_manual, from_addr FROM emails WHERE id = ?").get(emailId);
  if (!row) throw new NotFoundError(`Email ${emailId} not found`);
  const sender = (parseAddresses(row.from_addr)[0]?.address ?? "").trim().toLowerCase();

  const vote = (column: "important" | "not_important", by: 1 | -1, last: boolean | null) => {
    db.query(
      `INSERT INTO imbox_feedback (user_id, address, ${column}, last_verdict) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, address) DO UPDATE SET ${column} = MAX(${column} + ?, 0), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run(userId, sender, by === 1 ? 1 : 0, last === null ? null : last ? 1 : 0, by);
  };
  const settle = () => {
    // After taking a vote back: the latest opinion is what is left, and a sender nobody has an opinion on any more is forgotten.
    const entry = db.query<{ important: number; not_important: number; last_verdict: number | null }, [number, string]>("SELECT important, not_important, last_verdict FROM imbox_feedback WHERE user_id = ? AND address = ?").get(userId, sender);
    if (!entry) return;
    if (entry.important === 0 && entry.not_important === 0) db.query("DELETE FROM imbox_feedback WHERE user_id = ? AND address = ?").run(userId, sender);
    else if (entry.last_verdict === 1 && entry.important === 0) db.query("UPDATE imbox_feedback SET last_verdict = 0 WHERE user_id = ? AND address = ?").run(userId, sender);
    else if (entry.last_verdict === 0 && entry.not_important === 0) db.query("UPDATE imbox_feedback SET last_verdict = 1 WHERE user_id = ? AND address = ?").run(userId, sender);
  };

  db.transaction(() => {
    if (sender && row.imbox_manual && row.imbox !== null) {
      vote(row.imbox ? "important" : "not_important", -1, null);
      settle();
    }
    if (value === null) {
      db.query("UPDATE emails SET imbox = NULL, imbox_manual = 0 WHERE id = ?").run(emailId);
      return;
    }
    db.query("UPDATE emails SET imbox = ?, imbox_manual = 1 WHERE id = ?").run(value ? 1 : 0, emailId);
    if (sender) {
      vote(value ? "important" : "not_important", 1, value);
      db.query("UPDATE imbox_feedback SET last_verdict = ? WHERE user_id = ? AND address = ?").run(value ? 1 : 0, userId, sender);
    }
  })();
}

export function getMessageRow(db: Database, emailId: number): MessageRow {
  const row = db.query<MessageRow, [number]>(`SELECT ${MESSAGE_COLUMNS} FROM emails e WHERE e.id = ?`).get(emailId);
  if (!row) throw new NotFoundError(`Email ${emailId} not found`);
  return row;
}

/** Classifies one stored message and keeps the verdict — for mail that has just arrived. Never throws: mail that can't be classified stays unclassified. */
export function classifyAndStore(db: Database, context: ImboxContext, emailId: number): Classification | null {
  try {
    const row = getMessageRow(db, emailId);
    const result = context.classifyRow(row);
    setImbox(db, emailId, result.important);
    context.noteStored(row);
    return result;
  } catch (error) {
    console.error(`[imbox] couldn't classify message ${emailId}:`, error);
    return null;
  }
}

/** The verdict for one message, with the reasons — computed now, not stored. */
export function explainEmail(db: Database, userId: number, emailId: number): Classification {
  return createImboxContext(db, userId).classifyRow(getMessageRow(db, emailId));
}

export interface ClassifyResult {
  /** Messages looked at. */
  examined: number;
  important: number;
  notImportant: number;
}

const CHUNK = 500;

export interface ClassifyOptions {
  accountIds?: number[];
  force?: boolean;
  /** An account is about to be classified: how many messages there are to do, in which folders. */
  onAccount?: (info: { account: string; total: number; folders: string[] }) => void;
  /** After every chunk of up to 500 messages: how many of the current account's are done, and the running totals of the whole run. */
  onProgress?: (info: { account: string; done: number; total: number; important: number }) => void;
  /** Every single verdict, as it is made (for --verbose: it can be a lot of calls). */
  onMessage?: (info: { account: string; row: { id: number; subject: string | null; from: string }; verdict: Classification }) => void;
  /** One account is finished. */
  onAccountDone?: (info: { account: string } & ClassifyResult) => void;
}

/**
 * The work of classifyAccounts as a generator that pauses after every chunk, so a caller that serves other requests (the streaming
 * route) can let the event loop run between chunks; classifyAccounts itself just runs it to the end.
 */
export function* classifySteps(db: Database, userId: number, options: ClassifyOptions = {}): Generator<void, ClassifyResult> {
  const context = createImboxContext(db, userId);
  const accounts = db
    .query<AccountInfo & { id: number }, [number]>("SELECT id, email, display_name, sender_name, sent_folder, special_folders FROM accounts WHERE user_id = ? ORDER BY id")
    .all(userId)
    .filter(account => !options.accountIds || options.accountIds.includes(account.id));

  const result: ClassifyResult = { examined: 0, important: 0, notImportant: 0 };
  const update = db.query("UPDATE emails SET imbox = ? WHERE id = ?");

  for (const account of accounts) {
    const folders = inboxFolders(db, account, true);
    const marks = folders.map(() => "?").join(",");
    const where = `e.account_id = ? AND e.is_draft = 0 AND e.folder IN (${marks})${options.force ? "" : " AND e.imbox IS NULL"}`;
    const total =
      folders.length === 0 ? 0 : db.query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM emails e WHERE ${where} AND e.imbox_manual = 0`).get(account.id, ...folders)!.n;
    options.onAccount?.({ account: account.email, total, folders });

    const mine: ClassifyResult = { examined: 0, important: 0, notImportant: 0 };
    if (total > 0) {
      const query = db.query<MessageRow, (string | number)[]>(`SELECT ${MESSAGE_COLUMNS} FROM emails e WHERE ${where} AND e.imbox_manual = 0 AND e.id > ? ORDER BY e.id LIMIT ${CHUNK}`);

      let lastId = 0;
      for (;;) {
        const rows = query.all(account.id, ...folders, lastId);
        if (rows.length === 0) break;
        db.transaction(() => {
          for (const row of rows) {
            const verdict = context.classifyRow(row);
            update.run(verdict.important ? 1 : 0, row.id);
            mine.examined += 1;
            if (verdict.important) mine.important += 1;
            else mine.notImportant += 1;
            options.onMessage?.({ account: account.email, row: { id: row.id, subject: row.subject, from: parseAddresses(row.from_addr)[0]?.address ?? "" }, verdict });
          }
        })();
        lastId = rows[rows.length - 1]!.id;
        options.onProgress?.({ account: account.email, done: mine.examined, total, important: mine.important });
        yield;
      }
    }
    result.examined += mine.examined;
    result.important += mine.important;
    result.notImportant += mine.notImportant;
    options.onAccountDone?.({ account: account.email, ...mine });
  }
  return result;
}

/**
 * Classifies the stored mail of some of the user's accounts: every message in an incoming folder that has no verdict yet, or all of
 * them with `force`. Messages are read in chunks of 500 by id, and a chunk's verdicts are written in one transaction, so it is
 * fast (tens of thousands of messages a second) and can be stopped at any time without losing what was done.
 */
export function classifyAccounts(db: Database, userId: number, options: ClassifyOptions = {}): ClassifyResult {
  const steps = classifySteps(db, userId, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}
