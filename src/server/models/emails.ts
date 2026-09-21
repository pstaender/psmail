import { Database } from "bun:sqlite";
import { recordContacts } from "./contacts";
import { NotFoundError, type AttachmentRecord, type EmailAddress, type EmailRecord } from "../types";
import { listFilterSql, type ListFilter } from "./dateBounds";

type SqlBindings = (string | number | null)[];

interface EmailRow {
  id: number;
  account_id: number;
  folder: string;
  uid: number | null;
  is_draft: number;
  is_read: number;
  is_flagged: number;
  is_forwarded?: number;
  message_id: string | null;
  in_reply_to: string | null;
  from_addr: string | null;
  to_addr: string | null;
  cc_addr: string | null;
  bcc_addr: string | null;
  reply_to_addr: string | null;
  subject: string | null;
  date: string | null;
  return_path: string | null;
  received: string | null;
  mime_version: string | null;
  content_type: string | null;
  authentication_results: string | null;
  dkim: string | null;
  spf: string | null;
  plain_text: string | null;
  html_text: string | null;
  headers_raw: string | null;
  size: number | null;
  created_at: string;
  updated_at: string;
  /** Only present on message-list rows (see LIST_COLUMNS). */
  attachment_count?: number;
  /** AI results — absent on message-list rows. */
  taxonomy_list?: string | null;
  ai_summary?: string | null;
  translated_text?: string | null;
  translated_language?: string | null;
  calendar_events?: string | null;
  imbox?: number | null;
  imbox_manual?: number;
}

interface AttachmentRow {
  id: number;
  email_id: number;
  filename: string;
  content_type: string | null;
  content_id: string | null;
  is_inline: number;
  size: number;
  file_path: string;
}

function parseAddrList(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function parseStringList(json: string | null): string[] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function toEmail(row: EmailRow, attachments?: AttachmentRow[]): EmailRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    folder: row.folder,
    uid: row.uid,
    isDraft: !!row.is_draft,
    isRead: !!row.is_read,
    isFlagged: !!row.is_flagged,
    isForwarded: !!row.is_forwarded,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    from: parseAddrList(row.from_addr),
    to: parseAddrList(row.to_addr),
    cc: parseAddrList(row.cc_addr),
    bcc: parseAddrList(row.bcc_addr),
    replyTo: parseAddrList(row.reply_to_addr),
    subject: row.subject,
    date: row.date,
    returnPath: row.return_path,
    received: parseStringList(row.received),
    mimeVersion: row.mime_version,
    contentType: row.content_type,
    authenticationResults: row.authentication_results,
    dkim: row.dkim,
    spf: row.spf,
    plainText: row.plain_text,
    htmlText: row.html_text,
    headersRaw: row.headers_raw,
    size: row.size,
    taxonomyList: parseStringList(row.taxonomy_list ?? null),
    calendarEvents: parseStringList(row.calendar_events ?? null),
    imbox: row.imbox === null || row.imbox === undefined ? null : !!row.imbox,
    aiSummary: row.ai_summary ?? null,
    translatedText: row.translated_text ?? null,
    translatedLanguage: row.translated_language ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: attachments?.map(toAttachment),
    ...(row.attachment_count !== undefined ? { attachmentCount: row.attachment_count } : {}),
  };
}

function toAttachment(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    emailId: row.email_id,
    filename: row.filename,
    contentType: row.content_type,
    contentId: row.content_id,
    isInline: !!row.is_inline,
    size: row.size,
  };
}

export interface EmailInput {
  folder?: string;
  uid?: number | null;
  isDraft?: boolean;
  isRead?: boolean;
  isFlagged?: boolean;
  /** The message was forwarded (never turned off again). */
  isForwarded?: boolean;
  messageId?: string | null;
  inReplyTo?: string | null;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject?: string | null;
  date?: string | null;
  returnPath?: string | null;
  received?: string[];
  mimeVersion?: string | null;
  contentType?: string | null;
  authenticationResults?: string | null;
  dkim?: string | null;
  spf?: string | null;
  plainText?: string | null;
  htmlText?: string | null;
  headersRaw?: string | null;
  size?: number | null;
}

export function createEmail(db: Database, accountId: number, input: EmailInput): EmailRecord {
  const row = db
    .query<EmailRow, SqlBindings>(
      `INSERT INTO emails (
        account_id, folder, uid, is_draft, is_read, is_flagged,
        message_id, in_reply_to, from_addr, to_addr, cc_addr, bcc_addr, reply_to_addr,
        subject, date, return_path, received, mime_version, content_type,
        authentication_results, dkim, spf, plain_text, html_text, headers_raw, size
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`
    )
    .get(
      accountId,
      input.folder ?? "Drafts",
      input.uid ?? null,
      input.isDraft ?? true ? 1 : 0,
      input.isRead ? 1 : 0,
      input.isFlagged ? 1 : 0,
      input.messageId ?? null,
      input.inReplyTo ?? null,
      JSON.stringify(input.from ?? []),
      JSON.stringify(input.to ?? []),
      JSON.stringify(input.cc ?? []),
      JSON.stringify(input.bcc ?? []),
      JSON.stringify(input.replyTo ?? []),
      input.subject ?? null,
      input.date ?? null,
      input.returnPath ?? null,
      JSON.stringify(input.received ?? []),
      input.mimeVersion ?? null,
      input.contentType ?? null,
      input.authenticationResults ?? null,
      input.dkim ?? null,
      input.spf ?? null,
      input.plainText ?? null,
      input.htmlText ?? null,
      input.headersRaw ?? null,
      input.size ?? null
    );

  const created = toEmail(row!);
  if (!created.isDraft) recordContactsFor(db, accountId, created);
  return created;
}

/** Feeds a stored (non-draft) message into the account's autocomplete contacts. */
function recordContactsFor(db: Database, accountId: number, email: EmailRecord, forceOutgoing = false): void {
  const own = db.query<{ email: string }, [number]>("SELECT email FROM accounts WHERE id = ?").get(accountId)?.email;
  if (!own) return;
  const outgoing = forceOutgoing || email.from.some(a => a.address?.toLowerCase() === own.toLowerCase());
  recordContacts(db, accountId, own, email, outgoing);
}

export interface ListEmailsOptions extends ListFilter {
  folder?: string;
  limit?: number;
  offset?: number;
}

export interface FolderCount {
  folder: string;
  total: number;
  unread: number;
}

/** Local (already-synced) message counts per folder, for badges in the folder tree. */
export function getFolderCounts(db: Database, accountId: number): FolderCount[] {
  const rows = db
    .query<{ folder: string; total: number; unread: number }, [number]>(
      `SELECT folder, COUNT(*) as total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread
       FROM emails WHERE account_id = ? GROUP BY folder`
    )
    .all(accountId);
  return rows;
}

/**
 * Columns for the message list. Deliberately leaves out the heavy bodies (html_text, headers_raw,
 * ...) — loading those for every row made listing a few thousand messages slow — and returns just the
 * first 200 characters of plain_text as the snippet. The full message comes from getEmail().
 */
const LIST_COLUMNS = `id, account_id, folder, uid, is_draft, is_read, is_flagged, message_id, in_reply_to,
  from_addr, to_addr, cc_addr, bcc_addr, reply_to_addr, subject, date, size, created_at, updated_at, taxonomy_list, imbox,
  substr(plain_text, 1, 200) AS plain_text,
  (SELECT COUNT(*) FROM attachments WHERE email_id = emails.id AND is_inline = 0) AS attachment_count`;

export function listEmails(db: Database, accountId: number, options: ListEmailsOptions = {}): EmailRecord[] {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  // A date window is plain range conditions after the folder, so the (account, folder, date, id) index still serves the
  // list in order: the rows come straight off a range of it, without reading the rest of the folder or sorting.
  const window = listFilterSql(options);
  const rows = options.folder
    ? db
        .query<EmailRow, (string | number)[]>(
          `SELECT ${LIST_COLUMNS} FROM emails WHERE account_id = ? AND folder = ?${window.sql} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(accountId, options.folder, ...window.params, limit, offset)
    : db
        .query<EmailRow, (string | number)[]>(
          `SELECT ${LIST_COLUMNS} FROM emails WHERE account_id = ?${window.sql} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(accountId, ...window.params, limit, offset);

  return rows.map(row => toEmail(row));
}

export function getEmailRow(db: Database, id: number): EmailRow {
  const row = db.query<EmailRow, [number]>("SELECT * FROM emails WHERE id = ?").get(id);
  if (!row) throw new NotFoundError(`Email ${id} not found`);
  return row;
}

export function getEmail(db: Database, id: number): EmailRecord {
  const row = getEmailRow(db, id);
  const attachments = db
    .query<AttachmentRow, [number]>("SELECT * FROM attachments WHERE email_id = ? ORDER BY id")
    .all(id);
  return toEmail(row, attachments);
}

export function findEmailByUid(db: Database, accountId: number, folder: string, uid: number): EmailRow | null {
  return db
    .query<EmailRow, [number, string, number]>(
      "SELECT * FROM emails WHERE account_id = ? AND folder = ? AND uid = ?"
    )
    .get(accountId, folder, uid);
}

export interface SyncedEmailRef {
  id: number;
  uid: number;
  isRead: boolean;
  isFlagged: boolean;
  isForwarded: boolean;
}

/**
 * Every already-synced (non-null UID) local row in `folder` — for reconciling with the
 * server's current flags/existence during a two-way sync (see reconcileExisting in
 * services/sync.ts). Deliberately lean (no body/headers) since it may cover a whole folder.
 */
export function listSyncedRefs(db: Database, accountId: number, folder: string): SyncedEmailRef[] {
  const rows = db
    .query<{ id: number; uid: number; is_read: number; is_flagged: number; is_forwarded: number }, [number, string]>(
      "SELECT id, uid, is_read, is_flagged, is_forwarded FROM emails WHERE account_id = ? AND folder = ? AND uid IS NOT NULL"
    )
    .all(accountId, folder);
  return rows.map(row => ({ id: row.id, uid: row.uid, isRead: !!row.is_read, isFlagged: !!row.is_flagged, isForwarded: !!row.is_forwarded }));
}

export function updateEmail(db: Database, id: number, input: EmailInput): EmailRecord {
  const existing = getEmailRow(db, id);

  const merged = {
    folder: input.folder ?? existing.folder,
    uid: input.uid !== undefined ? input.uid : existing.uid,
    is_draft: input.isDraft !== undefined ? (input.isDraft ? 1 : 0) : existing.is_draft,
    is_read: input.isRead !== undefined ? (input.isRead ? 1 : 0) : existing.is_read,
    is_flagged: input.isFlagged !== undefined ? (input.isFlagged ? 1 : 0) : existing.is_flagged,
    is_forwarded: input.isForwarded ? 1 : existing.is_forwarded, // forwarded stays forwarded
    message_id: input.messageId !== undefined ? input.messageId : existing.message_id,
    in_reply_to: input.inReplyTo !== undefined ? input.inReplyTo : existing.in_reply_to,
    from_addr: input.from !== undefined ? JSON.stringify(input.from) : existing.from_addr,
    to_addr: input.to !== undefined ? JSON.stringify(input.to) : existing.to_addr,
    cc_addr: input.cc !== undefined ? JSON.stringify(input.cc) : existing.cc_addr,
    bcc_addr: input.bcc !== undefined ? JSON.stringify(input.bcc) : existing.bcc_addr,
    reply_to_addr: input.replyTo !== undefined ? JSON.stringify(input.replyTo) : existing.reply_to_addr,
    subject: input.subject !== undefined ? input.subject : existing.subject,
    date: input.date !== undefined ? input.date : existing.date,
    return_path: input.returnPath !== undefined ? input.returnPath : existing.return_path,
    received: input.received !== undefined ? JSON.stringify(input.received) : existing.received,
    mime_version: input.mimeVersion !== undefined ? input.mimeVersion : existing.mime_version,
    content_type: input.contentType !== undefined ? input.contentType : existing.content_type,
    authentication_results:
      input.authenticationResults !== undefined ? input.authenticationResults : existing.authentication_results,
    dkim: input.dkim !== undefined ? input.dkim : existing.dkim,
    spf: input.spf !== undefined ? input.spf : existing.spf,
    plain_text: input.plainText !== undefined ? input.plainText : existing.plain_text,
    html_text: input.htmlText !== undefined ? input.htmlText : existing.html_text,
    headers_raw: input.headersRaw !== undefined ? input.headersRaw : existing.headers_raw,
    size: input.size !== undefined ? input.size : existing.size,
  };

  const row = db
    .query<EmailRow, SqlBindings>(
      `UPDATE emails SET
        folder = ?, uid = ?, is_draft = ?, is_read = ?, is_flagged = ?, is_forwarded = ?,
        message_id = ?, in_reply_to = ?, from_addr = ?, to_addr = ?, cc_addr = ?, bcc_addr = ?, reply_to_addr = ?,
        subject = ?, date = ?, return_path = ?, received = ?, mime_version = ?, content_type = ?,
        authentication_results = ?, dkim = ?, spf = ?, plain_text = ?, html_text = ?, headers_raw = ?, size = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
      RETURNING *`
    )
    .get(
      merged.folder,
      merged.uid,
      merged.is_draft,
      merged.is_read,
      merged.is_flagged,
      merged.is_forwarded ?? 0,
      merged.message_id,
      merged.in_reply_to,
      merged.from_addr,
      merged.to_addr,
      merged.cc_addr,
      merged.bcc_addr,
      merged.reply_to_addr,
      merged.subject,
      merged.date,
      merged.return_path,
      merged.received,
      merged.mime_version,
      merged.content_type,
      merged.authentication_results,
      merged.dkim,
      merged.spf,
      merged.plain_text,
      merged.html_text,
      merged.headers_raw,
      merged.size,
      id
    );

  const updated = toEmail(row!);
  // A draft turning into a sent message is the moment its recipients become contacts.
  if (existing.is_draft && !updated.isDraft) recordContactsFor(db, existing.account_id, updated, true);
  return updated;
}

/**
 * `newUid` is only relevant when the move was also pushed to IMAP: a MOVE re-assigns the
 * message a UID scoped to the destination folder, so the local row must follow along (else
 * a later single-message IMAP action on it would target the wrong/nonexistent UID). Omit it
 * for a local-only move (read-only account, or a draft that was never on the server).
 */
export function moveEmail(db: Database, id: number, folder: string, newUid?: number | null): EmailRecord {
  const row =
    newUid === undefined
      ? db
          .query<EmailRow, [string, number]>(
            `UPDATE emails SET folder = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *`
          )
          .get(folder, id)
      : db
          .query<EmailRow, [string, number | null, number]>(
            `UPDATE emails SET folder = ?, uid = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *`
          )
          .get(folder, newUid, id);
  if (!row) throw new NotFoundError(`Email ${id} not found`);
  return toEmail(row);
}

export function deleteEmail(db: Database, id: number): void {
  const result = db.query("DELETE FROM emails WHERE id = ?").run(id);
  if (result.changes === 0) throw new NotFoundError(`Email ${id} not found`);
}

export function addAttachment(
  db: Database,
  emailId: number,
  attachment: { filename: string; contentType?: string | null; contentId?: string | null; isInline?: boolean; size: number; filePath: string }
): AttachmentRecord {
  const row = db
    .query<AttachmentRow, [number, string, string | null, string | null, number, number, string]>(
      `INSERT INTO attachments (email_id, filename, content_type, content_id, is_inline, size, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      emailId,
      attachment.filename,
      attachment.contentType ?? null,
      attachment.contentId ?? null,
      attachment.isInline ? 1 : 0,
      attachment.size,
      attachment.filePath
    );
  return toAttachment(row!);
}

export function getAttachmentRow(db: Database, id: number): AttachmentRow {
  const row = db.query<AttachmentRow, [number]>("SELECT * FROM attachments WHERE id = ?").get(id);
  if (!row) throw new NotFoundError(`Attachment ${id} not found`);
  return row;
}

export function deleteAttachment(db: Database, id: number): void {
  const result = db.query("DELETE FROM attachments WHERE id = ?").run(id);
  if (result.changes === 0) throw new NotFoundError(`Attachment ${id} not found`);
}

export type { EmailRow, AttachmentRow };

/** The categories (AI taxonomy labels) of the given messages that have any — for lists that don't load whole messages. */
export function taxonomyListsFor(db: Database, ids: number[]): Map<number, string[]> {
  const found = new Map<number, string[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .query<{ id: number; taxonomy_list: string }, number[]>(
        `SELECT id, taxonomy_list FROM emails WHERE taxonomy_list IS NOT NULL AND taxonomy_list != '[]' AND id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(...chunk);
    for (const row of rows) {
      const labels = parseStringList(row.taxonomy_list).filter(label => typeof label === "string");
      if (labels.length > 0) found.set(row.id, labels);
    }
  }
  return found;
}

/**
 * Every category (AI taxonomy label) the user's messages have, with how many messages carry it — most used first, then by name.
 * Only messages that have labels are read, and only that one small column.
 */
export function listCategories(db: Database, userId: number): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  const rows = db
    .query<{ taxonomy_list: string }, [number]>(
      `SELECT emails.taxonomy_list FROM emails JOIN accounts ON accounts.id = emails.account_id
       WHERE accounts.user_id = ? AND emails.taxonomy_list IS NOT NULL AND emails.taxonomy_list != '[]'`
    )
    .all(userId);
  for (const row of rows) {
    for (const label of new Set(parseStringList(row.taxonomy_list))) {
      if (typeof label === "string" && label.trim() !== "") counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Of the given message ids, those that have at least one real (non-inline) attachment — for lists that don't load attachments themselves. */
export function emailIdsWithAttachments(db: Database, ids: number[]): Set<number> {
  const found = new Set<number>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .query<{ email_id: number }, number[]>(
        `SELECT DISTINCT email_id FROM attachments WHERE is_inline = 0 AND email_id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(...chunk);
    for (const row of rows) found.add(row.email_id);
  }
  return found;
}

export interface AiFieldsPatch {
  aiSummary?: string | null;
  taxonomyList?: string[];
  translatedText?: string | null;
  translatedLanguage?: string | null;
  calendarEvents?: string[];
}

/** Stores AI results on a message (and nothing else: updated_at stays, so a summary doesn't reorder anything). */
export function setEmailAiFields(db: Database, id: number, patch: AiFieldsPatch): EmailRecord {
  const existing = getEmailRow(db, id);
  db.query("UPDATE emails SET ai_summary = ?, taxonomy_list = ?, translated_text = ?, translated_language = ?, calendar_events = ? WHERE id = ?").run(
    patch.aiSummary !== undefined ? patch.aiSummary : existing.ai_summary ?? null,
    patch.taxonomyList !== undefined ? JSON.stringify(patch.taxonomyList) : existing.taxonomy_list ?? null,
    patch.translatedText !== undefined ? patch.translatedText : existing.translated_text ?? null,
    patch.translatedLanguage !== undefined ? patch.translatedLanguage : existing.translated_language ?? null,
    patch.calendarEvents !== undefined ? JSON.stringify(patch.calendarEvents) : existing.calendar_events ?? null,
    id
  );
  return getEmail(db, id);
}
