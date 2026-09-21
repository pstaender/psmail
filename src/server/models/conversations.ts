import type { Database } from "bun:sqlite";
import type { EmailAddress } from "../types";
import { NotFoundError } from "../types";

/**
 * Conversations: messages that belong together, found from what the messages say about each other — `Message-ID`, `In-Reply-To` and
 * `References` — across all of the user's accounts (a conversation is usually an Inbox message and the reply in Sent).
 *
 * Nothing is stored for it. The list only needs to know, for the messages on the page, whether the user has answered them and whether
 * they have relatives in the mailbox (two indexed lookups per page); the whole conversation of one message is walked on demand when
 * the message is opened (parents and children, level by level, over the same indexes).
 */

/** Small facts about a message's conversation, for the message lists. */
export interface ConversationInfo {
  /** One of the user's own addresses has answered this message. */
  replied: boolean;
  /** How many messages in the mailbox are directly related to it: the one it answers (if stored) and the ones that answer it. */
  related: number;
}

export interface ConversationMessage {
  id: number;
  accountEmail: string;
  folder: string;
  subject: string | null;
  from: EmailAddress | null;
  date: string | null;
  isRead: boolean;
  /** Written by the user (from one of their own addresses). */
  own: boolean;
  /** The start of the text, whitespace collapsed. */
  snippet: string;
  /** The message the conversation was asked for. */
  current: boolean;
}

export interface Conversation {
  /** Oldest first. Just the message itself when it has no relatives. */
  messages: ConversationMessage[];
  /** The user's latest answer to exactly this message, if there is one — what "See reply" opens. */
  repliedBy: number | null;
}

const MAX_MESSAGES = 60;
const MAX_ROUNDS = 12;
const SNIPPET_LENGTH = 160;

function parseFirst(json: string | null): EmailAddress | null {
  try {
    const list = json ? JSON.parse(json) : [];
    return Array.isArray(list) && list[0] ? list[0] : null;
  } catch {
    return null;
  }
}

const marks = (n: number) => Array(n).fill("?").join(",");

/** Message ids a message refers to: In-Reply-To and References (the newest few), with their angle brackets. */
function referencedIds(inReplyTo: string | null, headers: string | null): string[] {
  const unfolded = (headers ?? "").replace(/\r?\n[ \t]+/g, " ");
  const references = /^references:[ \t]*(.*)$/im.exec(unfolded)?.[1] ?? "";
  const ids = [...(inReplyTo ?? "").matchAll(/<[^<>\s]+>/g), ...references.matchAll(/<[^<>\s]+>/g)].map(match => match[0]);
  return [...new Set(ids)].slice(-12);
}

interface Scope {
  accountIds: number[];
  ownAddresses: Set<string>;
  accountEmails: Map<number, string>;
}

function scopeOf(db: Database, userId: number): Scope {
  const accounts = db.query<{ id: number; email: string }, [number]>("SELECT id, email FROM accounts WHERE user_id = ?").all(userId);
  return {
    accountIds: accounts.map(a => a.id),
    ownAddresses: new Set(accounts.map(a => a.email.toLowerCase())),
    accountEmails: new Map(accounts.map(a => [a.id, a.email])),
  };
}

const isOwn = (scope: Scope, fromJson: string | null) => scope.ownAddresses.has((parseFirst(fromJson)?.address ?? "").trim().toLowerCase());

/**
 * For the messages of one page of a list: has the user answered each, and does it have relatives. Only messages that do are in the
 * result. Two lookups by index for the whole page: who answers these ids (`in_reply_to`), and which of the ids they answer are stored.
 */
export function conversationInfoFor(db: Database, userId: number, ids: number[]): Map<number, ConversationInfo> {
  const result = new Map<number, ConversationInfo>();
  if (ids.length === 0) return result;
  const scope = scopeOf(db, userId);
  for (let i = 0; i < ids.length; i += 400) collectInfo(db, scope, ids.slice(i, i + 400), result);
  return result;
}

function collectInfo(db: Database, scope: Scope, ids: number[], result: Map<number, ConversationInfo>): void {
  if (scope.accountIds.length === 0) return;
  const scoped = scope.accountIds.join(",");

  const rows = db
    .query<{ id: number; message_id: string | null; in_reply_to: string | null }, number[]>(
      `SELECT id, message_id, in_reply_to FROM emails WHERE id IN (${marks(ids.length)}) AND account_id IN (${scoped})`
    )
    .all(...ids);
  const messageIds = [...new Set(rows.map(r => r.message_id).filter((v): v is string => !!v))];
  const parentIds = [...new Set(rows.map(r => r.in_reply_to).filter((v): v is string => !!v))];

  // Who answers these messages. A copy of the same message in another folder (Gmail's labels) answers nothing, and drafts don't count.
  const answers = new Map<string, { count: number; ownAnswer: boolean }>();
  if (messageIds.length > 0) {
    for (const row of db
      .query<{ in_reply_to: string; from_addr: string | null }, string[]>(
        `SELECT in_reply_to, from_addr FROM emails WHERE in_reply_to IN (${marks(messageIds.length)}) AND is_draft = 0 AND account_id IN (${scoped})`
      )
      .all(...messageIds)) {
      const entry = answers.get(row.in_reply_to) ?? { count: 0, ownAnswer: false };
      entry.count += 1;
      if (isOwn(scope, row.from_addr)) entry.ownAnswer = true;
      answers.set(row.in_reply_to, entry);
    }
  }

  // Which of the messages they answer are in the mailbox.
  const storedParents = new Set<string>();
  if (parentIds.length > 0) {
    for (const row of db
      .query<{ message_id: string }, string[]>(`SELECT DISTINCT message_id FROM emails WHERE message_id IN (${marks(parentIds.length)}) AND account_id IN (${scoped})`)
      .all(...parentIds)) {
      storedParents.add(row.message_id);
    }
  }

  for (const row of rows) {
    const answered = row.message_id ? answers.get(row.message_id) : undefined;
    const related = (answered?.count ?? 0) + (row.in_reply_to && storedParents.has(row.in_reply_to) ? 1 : 0);
    if (related > 0 || answered?.ownAnswer) result.set(row.id, { replied: answered?.ownAnswer ?? false, related });
  }
}

interface ConversationRow {
  id: number;
  account_id: number;
  folder: string;
  message_id: string | null;
  in_reply_to: string | null;
  headers_raw: string | null;
  subject: string | null;
  from_addr: string | null;
  date: string | null;
  is_read: number;
  snippet: string | null;
}

const COLUMNS = `id, account_id, folder, message_id, in_reply_to, headers_raw, subject, from_addr, date, is_read, substr(plain_text, 1, 400) AS snippet`;

/**
 * The conversation a message is part of: walks from the message to what it answers (In-Reply-To, References) and to what answers it,
 * level by level, over the user's accounts, until nothing new turns up (at most 60 messages). Copies of one message in several folders
 * are one message; drafts are left out. Oldest first.
 */
export function getConversation(db: Database, userId: number, emailId: number): Conversation {
  const scope = scopeOf(db, userId);
  const scoped = scope.accountIds.join(",") || "0";
  const start = db.query<ConversationRow, [number]>(`SELECT ${COLUMNS} FROM emails WHERE id = ? AND account_id IN (${scoped}) AND is_draft = 0`).get(emailId);
  if (!start) throw new NotFoundError(`Email ${emailId} not found`);

  const found = new Map<number, ConversationRow>([[start.id, start]]);
  const seenMessageIds = new Set<string>(start.message_id ? [start.message_id] : []);
  let frontier: ConversationRow[] = [start];

  for (let round = 0; round < MAX_ROUNDS && frontier.length > 0 && found.size < MAX_MESSAGES; round++) {
    const refs = [...new Set(frontier.flatMap(row => referencedIds(row.in_reply_to, row.headers_raw)))];
    const mine = [...new Set(frontier.map(row => row.message_id).filter((v): v is string => !!v))];
    const next: ConversationRow[] = [];
    const take = (row: ConversationRow) => {
      if (found.has(row.id) || (row.message_id && seenMessageIds.has(row.message_id))) return;
      found.set(row.id, row);
      if (row.message_id) seenMessageIds.add(row.message_id);
      next.push(row);
    };
    if (refs.length > 0) {
      for (const row of db.query<ConversationRow, string[]>(`SELECT ${COLUMNS} FROM emails WHERE message_id IN (${marks(refs.length)}) AND is_draft = 0 AND account_id IN (${scoped})`).all(...refs)) take(row);
    }
    if (mine.length > 0) {
      for (const row of db.query<ConversationRow, string[]>(`SELECT ${COLUMNS} FROM emails WHERE in_reply_to IN (${marks(mine.length)}) AND is_draft = 0 AND account_id IN (${scoped})`).all(...mine)) take(row);
    }
    frontier = next;
  }

  const rows = [...found.values()].slice(0, MAX_MESSAGES);
  rows.sort((a, b) => (a.date ?? "9999") < (b.date ?? "9999") ? -1 : (a.date ?? "9999") > (b.date ?? "9999") ? 1 : a.id - b.id);

  // "See reply": the user's own newest answer to exactly this message.
  let repliedBy: number | null = null;
  if (start.message_id) {
    const answers = db
      .query<{ id: number; from_addr: string | null; date: string | null }, [string]>(
        `SELECT id, from_addr, date FROM emails WHERE in_reply_to = ? AND is_draft = 0 AND account_id IN (${scoped}) ORDER BY date DESC, id DESC`
      )
      .all(start.message_id);
    repliedBy = answers.find(row => isOwn(scope, row.from_addr))?.id ?? null;
  }

  return {
    repliedBy,
    messages: rows.map(row => ({
      id: row.id,
      accountEmail: scope.accountEmails.get(row.account_id) ?? "",
      folder: row.folder,
      subject: row.subject,
      from: parseFirst(row.from_addr),
      date: row.date,
      isRead: !!row.is_read,
      own: isOwn(scope, row.from_addr),
      snippet: (row.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH),
      current: row.id === start.id,
    })),
  };
}
