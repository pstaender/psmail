import nodemailer from "nodemailer";
import type { AttachmentRecord, EmailAddress, EmailRecord } from "../types";

export interface SmtpCredentials {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

function formatAddress(addr: EmailAddress): string {
  return addr.name ? `"${addr.name.replace(/"/g, '\\"')}" <${addr.address}>` : addr.address;
}

function formatAddressList(addrs: EmailAddress[]): string | undefined {
  return addrs.length > 0 ? addrs.map(formatAddress).join(", ") : undefined;
}

export interface AttachmentWithData extends AttachmentRecord {
  content: Buffer;
}

export async function sendDraftEmail(
  creds: SmtpCredentials,
  draft: EmailRecord,
  attachments: AttachmentWithData[] = []
): Promise<{ messageId: string }> {
  if (draft.from.length === 0) throw new Error("Draft has no From address");
  if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) {
    throw new Error("Draft has no recipients");
  }

  const transporter = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.username, pass: creds.password },
  });

  try {
    const info = await transporter.sendMail({
      from: formatAddress(draft.from[0]!),
      to: formatAddressList(draft.to),
      cc: formatAddressList(draft.cc),
      bcc: formatAddressList(draft.bcc),
      replyTo: formatAddressList(draft.replyTo),
      subject: draft.subject ?? "",
      text: draft.plainText ?? undefined,
      html: draft.htmlText ?? undefined,
      inReplyTo: draft.inReplyTo ?? undefined,
      attachments: attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType ?? undefined,
        cid: a.contentId ?? undefined,
      })),
    });

    return { messageId: info.messageId };
  } finally {
    transporter.close();
  }
}
