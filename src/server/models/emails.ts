import { Database } from "bun:sqlite";
import { NotFoundError, type AttachmentRecord, type EmailAddress, type EmailRecord } from "../types";

type SqlBindings = (string | number | null)[];

interface EmailRow {
  id: number;
  account_id: number;
  folder: string;
  uid: number | null;
  is_draft: number;
  is_read: number;
  is_flagged: number;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: attachments?.map(toAttachment),
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

  return toEmail(row!);
}

export interface ListEmailsOptions {
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

export function listEmails(db: Database, accountId: number, options: ListEmailsOptions = {}): EmailRecord[] {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const rows = options.folder
    ? db
        .query<EmailRow, [number, string, number, number]>(
          "SELECT * FROM emails WHERE account_id = ? AND folder = ? ORDER BY date DESC, id DESC LIMIT ? OFFSET ?"
        )
        .all(accountId, options.folder, limit, offset)
    : db
        .query<EmailRow, [number, number, number]>(
          "SELECT * FROM emails WHERE account_id = ? ORDER BY date DESC, id DESC LIMIT ? OFFSET ?"
        )
        .all(accountId, limit, offset);

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

export function updateEmail(db: Database, id: number, input: EmailInput): EmailRecord {
  const existing = getEmailRow(db, id);

  const merged = {
    folder: input.folder ?? existing.folder,
    uid: input.uid !== undefined ? input.uid : existing.uid,
    is_draft: input.isDraft !== undefined ? (input.isDraft ? 1 : 0) : existing.is_draft,
    is_read: input.isRead !== undefined ? (input.isRead ? 1 : 0) : existing.is_read,
    is_flagged: input.isFlagged !== undefined ? (input.isFlagged ? 1 : 0) : existing.is_flagged,
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
        folder = ?, uid = ?, is_draft = ?, is_read = ?, is_flagged = ?,
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

  return toEmail(row!);
}

export function moveEmail(db: Database, id: number, folder: string): EmailRecord {
  const row = db
    .query<EmailRow, [string, number]>(
      `UPDATE emails SET folder = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *`
    )
    .get(folder, id);
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
