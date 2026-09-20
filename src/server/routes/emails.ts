import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ImapFlow } from "imapflow";
import { assertAccountEnabled, decryptAccountCredentials, learnSpecialFolders, type AccountRow } from "../models/accounts";
import { addDeletedUid } from "../models/tombstones";
import {
  addAttachment,
  createEmail,
  deleteAttachment,
  deleteEmail,
  getAttachmentRow,
  getEmail,
  getEmailRow,
  listEmails,
  moveEmail,
  updateEmail,
  type EmailInput,
  type EmailRow,
} from "../models/emails";
import { json, noContent, parseIntParam, readJsonBody, requireAuth, requiredParam, withErrorHandling } from "../http";
import { getEmailAttachmentsDir, sanitizeSegment } from "../config/paths";
import { sendDraftEmail, type AttachmentWithData } from "../services/smtp";
import { buildStoredEml, emlFileName, zipStream, type ZipEntry } from "../services/eml";
import {
  appendMessage,
  createImapClient,
  deleteMessage,
  fetchMessageSource,
  listFolders,
  moveMessage,
  setMessageFlags,
  withImapClient,
  type FlagChanges,
} from "../services/imap";
import { resolveSpecialFolder } from "../../lib/folders";
import { getUserRowById } from "../models/users";
import { ApiError, NotFoundError, type AttachmentRecord, type EmailRecord } from "../types";
import { getOwnedAccountByEmailParam } from "./accounts";

const TRASH_FOLDER = "Trash";
const SENT_FOLDER = "Sent";

/** Throws NotFoundError unless the email row belongs to the given account. */
function getOwnedEmail(db: Database, emailId: number, accountId: number) {
  const row = getEmailRow(db, emailId);
  if (row.account_id !== accountId) throw new NotFoundError(`Email ${emailId} not found`);
  return row;
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * A local change (flag/move/delete) is only pushed to the IMAP server when the account isn't
 * read-only AND the message actually came from that server in the first place — a draft, or a
 * message sent but never successfully APPENDed to the Sent folder, has no UID and thus nothing
 * on the server to push to.
 */
export function canPushToImap(account: AccountRow, uid: number | null): boolean {
  return !account.read_only && !account.disabled && uid !== null;
}

/**
 * Soft-delete (move to Trash instead of expunging) is only offered when the server supports
 * UIDPLUS: the underlying move falls back to COPY + a bare EXPUNGE on servers without the MOVE
 * extension, and without UIDPLUS that EXPUNGE can also purge other unrelated \Deleted-flagged
 * messages sitting in the same folder. `skipSoftDelete` opts back into a permanent delete even
 * when soft-delete would otherwise be available. Deleting something already in Trash (whatever
 * its real path — see `trashFolder`) is always permanent — there's no Trash-in-Trash.
 */
export function wantsSoftDelete(account: AccountRow, folder: string, trashFolder: string): boolean {
  return account.imap_uidplus === 1 && !account.skip_soft_delete && folder !== trashFolder;
}

function imapCredentialsFor(account: AccountRow, imapPassword: string) {
  return {
    host: account.imap_host,
    port: account.imap_port,
    secure: !!account.imap_secure,
    username: account.imap_username,
    password: imapPassword,
  };
}

/** Pushes a flag change to IMAP (when applicable) and then applies it locally — in that order, so a failed push never touches local state. */
async function performFlagUpdate(
  db: Database,
  account: AccountRow,
  existing: EmailRow,
  patch: EmailInput,
  client?: ImapFlow
): Promise<EmailRecord> {
  const flagChanges: FlagChanges = {};
  if (patch.isRead !== undefined) flagChanges.seen = patch.isRead;
  if (patch.isFlagged !== undefined) flagChanges.flagged = patch.isFlagged;

  if (Object.keys(flagChanges).length > 0 && canPushToImap(account, existing.uid)) {
    await setMessageFlags(client!, existing.folder, existing.uid!, flagChanges);
  }
  return updateEmail(db, existing.id, patch);
}

/**
 * Deletes (or soft-deletes) a message: pushes to IMAP first when applicable, then mirrors the
 * same outcome locally. The real Trash folder path is resolved from the live IMAP listing
 * (not assumed to be literally named "Trash" — see resolveSpecialFolder), falling back to that
 * literal only when nothing on the server is recognizable as one.
 */
export async function performDelete(
  db: Database,
  account: AccountRow,
  existing: EmailRow,
  client?: ImapFlow
): Promise<{ softDeleted: boolean }> {
  if (canPushToImap(account, existing.uid)) {
    const liveFolders = client ? await listFolders(client) : [];
    const trashFolder = resolveSpecialFolder(liveFolders, "\\Trash", TRASH_FOLDER);

    if (wantsSoftDelete(account, existing.folder, trashFolder)) {
      const result = await moveMessage(client!, existing.folder, existing.uid!, trashFolder);
      moveEmail(db, existing.id, trashFolder, result.newUid);
      return { softDeleted: true };
    }
    await deleteMessage(client!, existing.folder, existing.uid!);
  } else if (existing.uid !== null) {
    // Local-only delete of a message that still exists on the server (read-only account): remember
    // its UID so the next sync doesn't just download it again.
    addDeletedUid(db, account.id, existing.folder, existing.uid);
  }
  deleteEmail(db, existing.id);
  return { softDeleted: false };
}

/** Moves a message: pushes to IMAP first when applicable (following the server's re-assigned UID), then mirrors it locally. */
async function performMove(
  db: Database,
  account: AccountRow,
  existing: EmailRow,
  folderName: string,
  client?: ImapFlow
): Promise<EmailRecord> {
  let newUid: number | null | undefined;
  if (canPushToImap(account, existing.uid)) {
    const result = await moveMessage(client!, existing.folder, existing.uid!, folderName);
    newUid = result.newUid;
  } else if (existing.uid !== null) {
    // Local-only move (read-only account): the server still has the message in its old folder, so
    // that UID must not be re-downloaded there — and here the message no longer corresponds to any
    // server UID (the old one belongs to the old folder), so it becomes a local-only row.
    addDeletedUid(db, account.id, existing.folder, existing.uid);
    newUid = null;
  }
  return moveEmail(db, existing.id, folderName, newUid);
}

interface BulkRequestBody {
  ids: number[];
}

interface BulkResult {
  id: number;
  ok: boolean;
  error?: string;
}

function requireIds(body: Partial<BulkRequestBody>): number[] {
  if (!Array.isArray(body.ids) || body.ids.length === 0) throw new ApiError(400, "ids must be a non-empty array");
  return body.ids;
}

const MAX_DOWNLOAD_MESSAGES = 5000;

/**
 * The .eml of each message, one at a time (so a zip never holds more than one in memory). The original source is read
 * from the IMAP server over one shared connection — opened only when a message has a UID, the account is enabled, and
 * closed when the download ends or is abandoned. A message the server can't give (a draft, a sent message that was
 * never copied there, an unreachable server, a disabled account) is built from what is stored instead.
 */
async function* emlEntries(db: Database, account: AccountRow, encryptionKey: Buffer, rows: EmailRow[]): AsyncGenerator<ZipEntry, void, undefined> {
  const names = new Set<string>();
  let client: ImapFlow | null = null;
  let serverUsable = !account.disabled;

  try {
    for (const row of rows) {
      let data: Buffer | null = null;

      if (serverUsable && row.uid !== null) {
        try {
          if (!client) {
            const { imapPassword } = decryptAccountCredentials(account, encryptionKey);
            const connecting = createImapClient(imapCredentialsFor(account, imapPassword));
            await connecting.connect();
            client = connecting;
          }
          data = await fetchMessageSource(client, row.folder, row.uid);
        } catch (error) {
          console.error(`[eml] ${account.email}: couldn't read message ${row.id} from the server, using the stored copy:`, error);
          if (!client || !client.usable) serverUsable = false; // the connection is gone: don't try again for every message
        }
      }

      const email = getEmail(db, row.id);
      if (!data) {
        const attachments: { record: AttachmentRecord; content: Buffer }[] = [];
        for (const record of email.attachments ?? []) {
          const file = Bun.file(getAttachmentRow(db, record.id).file_path);
          if (await file.exists()) attachments.push({ record, content: Buffer.from(await file.arrayBuffer()) });
        }
        data = await buildStoredEml(email, attachments);
      }

      yield { name: emlFileName(email, names), data, date: email.date ? new Date(email.date) : new Date() };
    }
  } finally {
    if (client) await (client as ImapFlow).logout().catch(() => (client as ImapFlow).close());
  }
}

/**
 * Runs `fn` once per id, sharing a single IMAP connection across the whole batch when any of
 * them will actually push to the server — bulk actions used to open one connection per
 * message, which doesn't scale to larger selections. Each id's outcome is independent: one
 * failing doesn't stop or roll back the rest.
 */
async function runBulkAction<T>(
  db: Database,
  account: AccountRow,
  encryptionKey: Buffer,
  ids: number[],
  fn: (existing: EmailRow, client?: ImapFlow) => Promise<T>
): Promise<(BulkResult & { value?: T })[]> {
  const rows = ids.map(id => ({ id, existing: getOwnedEmail(db, id, account.id) }));
  const results: (BulkResult & { value?: T })[] = [];

  const runOne = async (id: number, existing: EmailRow, client?: ImapFlow) => {
    try {
      const value = await fn(existing, client);
      results.push({ id, ok: true, value });
    } catch (error) {
      results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  // Local-only ids (read-only account, or a draft with no UID) never touch the network, so
  // they're handled up front — a connection failure for the ids that DO need pushing must not
  // block ones that never needed it in the first place.
  const localRows = rows.filter(r => !canPushToImap(account, r.existing.uid));
  const pushRows = rows.filter(r => canPushToImap(account, r.existing.uid));

  for (const { id, existing } of localRows) await runOne(id, existing);

  if (pushRows.length > 0) {
    const { imapPassword } = decryptAccountCredentials(account, encryptionKey);
    try {
      await withImapClient(imapCredentialsFor(account, imapPassword), async client => {
        for (const { id, existing } of pushRows) await runOne(id, existing, client);
      });
    } catch (error) {
      // The connection itself failed (bad host, auth, ...) before any of these ids could be
      // tried — every one of them fails closed with the same underlying error.
      const message = error instanceof Error ? error.message : String(error);
      for (const { id } of pushRows) results.push({ id, ok: false, error: message });
    }
  }

  return results;
}

export function emailsRoutes(db: Database) {
  return {
    "/api/accounts/:email/emails": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);

        const url = new URL(req.url);
        const folder = url.searchParams.get("folder") ?? undefined;
        const limit = url.searchParams.get("limit");
        const offset = url.searchParams.get("offset");

        return json(
          listEmails(db, account.id, {
            folder,
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
          })
        );
      }),
      POST: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);

        const body = await readJsonBody<EmailInput>(req);
        const email = createEmail(db, account.id, { ...body, folder: body.folder ?? "Drafts", isDraft: true });
        return json(email, { status: 201 });
      }),
    },
    // Download messages as .eml: one message as the file itself, several as a zip of .eml files, streamed.
    "/api/accounts/:email/emails/download": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const ids = requireIds(await readJsonBody<Partial<BulkRequestBody>>(req));
        if (ids.length > MAX_DOWNLOAD_MESSAGES) throw new ApiError(400, `At most ${MAX_DOWNLOAD_MESSAGES} messages can be downloaded at once.`);
        const rows = [...new Set(ids)].map(id => getOwnedEmail(db, id, account.id)); // all of them are checked before anything is sent

        const entries = emlEntries(db, account, encryptionKey, rows);
        if (rows.length === 1) {
          const entry = (await entries.next()).value as ZipEntry;
          await entries.return(undefined);
          return new Response(entry.data as Uint8Array<ArrayBuffer>, {
            headers: { "Content-Type": "message/rfc822", "Content-Disposition": contentDisposition(entry.name), "Cache-Control": "no-store" },
          });
        }
        return new Response(zipStream(entries), {
          headers: { "Content-Type": "application/zip", "Content-Disposition": contentDisposition(`${account.email} messages.zip`), "Cache-Control": "no-store" },
        });
      }),
    },
    "/api/accounts/:email/emails/bulk": {
      PATCH: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const body = await readJsonBody<Partial<BulkRequestBody> & EmailInput>(req);
        const ids = requireIds(body);

        const results = await runBulkAction(db, account, encryptionKey, ids, (existing, client) =>
          performFlagUpdate(db, account, existing, body, client)
        );
        return json(results.map(({ value, ...rest }) => rest));
      }),
      DELETE: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const body = await readJsonBody<Partial<BulkRequestBody>>(req);
        const ids = requireIds(body);

        const results = await runBulkAction(db, account, encryptionKey, ids, (existing, client) =>
          performDelete(db, account, existing, client)
        );
        return json(results.map(r => ({ id: r.id, ok: r.ok, error: r.error, softDeleted: r.value?.softDeleted ?? false })));
      }),
    },
    "/api/accounts/:email/emails/bulk/move/:folderName": {
      PATCH: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const folderName = decodeURIComponent(requiredParam(req.params.folderName, "folderName"));
        const body = await readJsonBody<Partial<BulkRequestBody>>(req);
        const ids = requireIds(body);

        const results = await runBulkAction(db, account, encryptionKey, ids, (existing, client) =>
          performMove(db, account, existing, folderName, client)
        );
        return json(results.map(({ value, ...rest }) => rest));
      }),
    },
    "/api/accounts/:email/emails/:emailId": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        getOwnedEmail(db, emailId, account.id);

        return json(getEmail(db, emailId));
      }),
      PATCH: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        const existing = getOwnedEmail(db, emailId, account.id);
        const body = await readJsonBody<EmailInput>(req);

        const needsPush =
          (body.isRead !== undefined || body.isFlagged !== undefined) && canPushToImap(account, existing.uid);

        let updated: EmailRecord;
        if (needsPush) {
          const { imapPassword } = decryptAccountCredentials(account, encryptionKey);
          updated = await withImapClient(imapCredentialsFor(account, imapPassword), client =>
            performFlagUpdate(db, account, existing, body, client)
          );
        } else {
          updated = await performFlagUpdate(db, account, existing, body);
        }

        return json(updated);
      }),
      DELETE: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        const existing = getOwnedEmail(db, emailId, account.id);

        let result: { softDeleted: boolean };
        if (canPushToImap(account, existing.uid)) {
          const { imapPassword } = decryptAccountCredentials(account, encryptionKey);
          result = await withImapClient(imapCredentialsFor(account, imapPassword), client =>
            performDelete(db, account, existing, client)
          );
        } else {
          result = await performDelete(db, account, existing);
        }

        return json(result);
      }),
    },
    "/api/accounts/:email/emails/:emailId/send": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        getOwnedEmail(db, emailId, account.id);

        const draft = getEmail(db, emailId);
        if (!draft.isDraft) throw new ApiError(409, "Email is not a draft");
        if (draft.from.length === 0) throw new ApiError(400, "Draft has no From address");
        if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) {
          throw new ApiError(400, "Draft has no recipients");
        }

        const { imapPassword, smtpPassword } = decryptAccountCredentials(account, encryptionKey);

        const attachmentsWithData: AttachmentWithData[] = await Promise.all(
          (draft.attachments ?? []).map(async attachment => {
            const attachmentRow = getAttachmentRow(db, attachment.id);
            const content = Buffer.from(await Bun.file(attachmentRow.file_path).arrayBuffer());
            return { ...attachment, content };
          })
        );

        const composed = await sendDraftEmail(
          {
            host: account.smtp_host,
            port: account.smtp_port,
            secure: !!account.smtp_secure,
            username: account.smtp_username,
            password: smtpPassword,
          },
          draft,
          attachmentsWithData
        );

        // Best-effort: SMTP has already irrevocably delivered the message by this point, so a
        // failure here (bad connection, server rejects the write, ...) must not fail the request
        // — that would look like sending itself failed and risk a confusing resend. It just means
        // this message won't show up in the Sent folder from other IMAP clients/webmail. The real
        // Sent path is resolved from the live IMAP listing (not assumed to be literally named
        // "Sent" — see resolveSpecialFolder), falling back to that literal if the connection fails
        // before it gets that far.
        let sentUid: number | null = null;
        let sentFolder = SENT_FOLDER;
        if (!account.read_only && !account.disabled) {
          try {
            sentFolder = await withImapClient(imapCredentialsFor(account, imapPassword), async client => {
              const liveFolders = await listFolders(client);
              const target = resolveSpecialFolder(liveFolders, "\\Sent", SENT_FOLDER);
              learnSpecialFolders(db, account.id, liveFolders);
              const result = await appendMessage(client, target, composed.raw, ["\\Seen"]);
              sentUid = result.uid;
              return target;
            });
          } catch (error) {
            console.error(`Failed to append sent message to IMAP Sent folder for ${account.email}:`, error);
          }
        }

        const sent = updateEmail(db, emailId, {
          isDraft: false,
          folder: sentFolder,
          uid: sentUid,
          messageId: composed.messageId,
          date: new Date().toISOString(),
        });

        return json(sent);
      }),
    },
    "/api/accounts/:email/emails/:emailId/move/:folderName": {
      PATCH: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        const existing = getOwnedEmail(db, emailId, account.id);
        const folderName = decodeURIComponent(requiredParam(req.params.folderName, "folderName"));

        let updated: EmailRecord;
        if (canPushToImap(account, existing.uid)) {
          const { imapPassword } = decryptAccountCredentials(account, encryptionKey);
          updated = await withImapClient(imapCredentialsFor(account, imapPassword), client =>
            performMove(db, account, existing, folderName, client)
          );
        } else {
          updated = await performMove(db, account, existing, folderName);
        }

        return json(updated);
      }),
    },
    "/api/accounts/:email/emails/:emailId/attachments": {
      POST: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        getOwnedEmail(db, emailId, account.id);

        const formData = await req.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) throw new ApiError(400, "Missing file field in form data");

        const username = getUserRowById(db, session.userId)!.username;
        const dir = getEmailAttachmentsDir(username, account.email, emailId);
        await Bun.$`mkdir -p ${dir}`.quiet();

        const safeName = sanitizeSegment(file.name);
        const filePath = join(dir, safeName);
        await Bun.write(filePath, await file.arrayBuffer());

        const attachment = addAttachment(db, emailId, {
          filename: file.name,
          contentType: file.type || null,
          isInline: false,
          size: file.size,
          filePath,
        });

        return json(attachment, { status: 201 });
      }),
    },
    "/api/accounts/:email/emails/:emailId/attachments/:attachmentId": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        getOwnedEmail(db, emailId, account.id);

        const attachmentId = parseIntParam(req.params.attachmentId, "attachmentId");
        const attachment = getAttachmentRow(db, attachmentId);
        if (attachment.email_id !== emailId) throw new NotFoundError(`Attachment ${attachmentId} not found`);

        const file = Bun.file(attachment.file_path);
        return new Response(file, {
          headers: {
            "Content-Type": attachment.content_type ?? "application/octet-stream",
            "Content-Disposition": contentDisposition(attachment.filename),
          },
        });
      }),
      DELETE: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        getOwnedEmail(db, emailId, account.id);

        const attachmentId = parseIntParam(req.params.attachmentId, "attachmentId");
        const attachment = getAttachmentRow(db, attachmentId);
        if (attachment.email_id !== emailId) throw new NotFoundError(`Attachment ${attachmentId} not found`);

        await Bun.file(attachment.file_path)
          .delete()
          .catch(() => {});
        deleteAttachment(db, attachmentId);
        return noContent();
      }),
    },
  };
}
