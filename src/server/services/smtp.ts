import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
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

export interface ComposedMessage {
  /** The exact raw RFC822 bytes that get sent — also what's APPENDed to the account's IMAP Sent folder, so the two stay byte-identical. */
  raw: Buffer;
  messageId: string;
}

/** Builds the raw message without sending it — a pure, network-free step, split out so it can be unit-tested by parsing the result back with mailparser. */
export async function composeMessage(draft: EmailRecord, attachments: AttachmentWithData[] = []): Promise<ComposedMessage> {
  const mimeNode = new MailComposer({
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
  }).compile();

  const messageId = mimeNode.messageId();
  const raw = await mimeNode.build();
  return { raw, messageId };
}

export async function sendDraftEmail(
  creds: SmtpCredentials,
  draft: EmailRecord,
  attachments: AttachmentWithData[] = []
): Promise<ComposedMessage> {
  if (draft.from.length === 0) throw new Error("Draft has no From address");
  if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) {
    throw new Error("Draft has no recipients");
  }

  const composed = await composeMessage(draft, attachments);
  const envelopeTo = [...draft.to, ...draft.cc, ...draft.bcc].map(a => a.address);

  const transporter = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.username, pass: creds.password },
  });

  try {
    await transporter.sendMail({
      raw: composed.raw,
      envelope: { from: draft.from[0]!.address, to: envelopeTo },
    });
  } finally {
    transporter.close();
  }

  return composed;
}
