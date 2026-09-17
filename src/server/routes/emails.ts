import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { decryptAccountCredentials } from "../models/accounts";
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
} from "../models/emails";
import { json, noContent, parseIntParam, readJsonBody, requireAuth, requiredParam, withErrorHandling } from "../http";
import { getEmailAttachmentsDir, sanitizeSegment } from "../config/paths";
import { sendDraftEmail, type AttachmentWithData } from "../services/smtp";
import { getUserRowById } from "../models/users";
import { ApiError, NotFoundError } from "../types";
import { getOwnedAccountByEmailParam } from "./accounts";

/** Throws NotFoundError unless the email row belongs to the given account. */
function getOwnedEmail(db: Database, emailId: number, accountId: number) {
  const row = getEmailRow(db, emailId);
  if (row.account_id !== accountId) throw new NotFoundError(`Email ${emailId} not found`);
  return row;
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

        const body = await readJsonBody<EmailInput>(req);
        const email = createEmail(db, account.id, { ...body, folder: body.folder ?? "Drafts", isDraft: true });
        return json(email, { status: 201 });
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
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        getOwnedEmail(db, emailId, account.id);

        const body = await readJsonBody<EmailInput>(req);
        return json(updateEmail(db, emailId, body));
      }),
      DELETE: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        getOwnedEmail(db, emailId, account.id);

        deleteEmail(db, emailId);
        return noContent();
      }),
    },
    "/api/accounts/:email/emails/:emailId/send": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        getOwnedEmail(db, emailId, account.id);

        const draft = getEmail(db, emailId);
        if (!draft.isDraft) throw new ApiError(409, "Email is not a draft");
        if (draft.from.length === 0) throw new ApiError(400, "Draft has no From address");
        if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) {
          throw new ApiError(400, "Draft has no recipients");
        }

        const { smtpPassword } = decryptAccountCredentials(account, encryptionKey);

        const attachmentsWithData: AttachmentWithData[] = await Promise.all(
          (draft.attachments ?? []).map(async attachment => {
            const attachmentRow = getAttachmentRow(db, attachment.id);
            const content = Buffer.from(await Bun.file(attachmentRow.file_path).arrayBuffer());
            return { ...attachment, content };
          })
        );

        const result = await sendDraftEmail(
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

        const sent = updateEmail(db, emailId, {
          isDraft: false,
          folder: "Sent",
          messageId: result.messageId,
          date: new Date().toISOString(),
        });

        return json(sent);
      }),
    },
    "/api/accounts/:email/emails/:emailId/move/:folderName": {
      PATCH: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        getOwnedEmail(db, emailId, account.id);

        const folderName = decodeURIComponent(requiredParam(req.params.folderName, "folderName"));
        return json(moveEmail(db, emailId, folderName));
      }),
    },
    "/api/accounts/:email/emails/:emailId/attachments": {
      POST: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
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
            "Content-Disposition": `attachment; filename="${attachment.filename.replace(/"/g, "")}"`,
          },
        });
      }),
      DELETE: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
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
