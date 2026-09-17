import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { EmailAddress } from "../types";

export interface ParsedAttachment {
  filename: string;
  contentType: string | null;
  contentId: string | null;
  isInline: boolean;
  size: number;
  content: Buffer;
}

export interface ParsedMessage {
  messageId: string | null;
  inReplyTo: string | null;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string | null;
  date: string | null;
  returnPath: string | null;
  received: string[];
  mimeVersion: string | null;
  contentType: string | null;
  authenticationResults: string | null;
  dkim: string | null;
  spf: string | null;
  plainText: string | null;
  htmlText: string | null;
  headersRaw: string;
  attachments: ParsedAttachment[];
}

function addressListToEmailAddresses(addr: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!addr) return [];
  const objects = Array.isArray(addr) ? addr : [addr];
  return objects.flatMap(obj => obj.value.map(v => ({ name: v.name || undefined, address: v.address ?? "" })));
}

/**
 * mailparser's `headers` Map structurally parses well-known headers (e.g.
 * return-path, content-type) into objects rather than plain strings, which
 * is unhelpful here — we want the raw header value for storage. `headerLines`
 * always carries the original "Key: value" text, so we extract from there
 * instead, matching by lowercased key.
 */
function rawHeaderValues(headerLines: ParsedMail["headerLines"], key: string): string[] {
  const lowerKey = key.toLowerCase();
  return headerLines
    .filter(h => h.key.toLowerCase() === lowerKey)
    .map(h => h.line.slice(h.line.indexOf(":") + 1).trim());
}

function rawHeaderValue(headerLines: ParsedMail["headerLines"], key: string): string | null {
  const values = rawHeaderValues(headerLines, key);
  return values.length > 0 ? values.join("\n") : null;
}

export async function parseMessage(source: Buffer): Promise<ParsedMessage> {
  const mail: ParsedMail = await simpleParser(source);
  const headerLines = mail.headerLines;

  return {
    messageId: mail.messageId ?? null,
    inReplyTo: mail.inReplyTo ?? null,
    from: addressListToEmailAddresses(mail.from),
    to: addressListToEmailAddresses(mail.to),
    cc: addressListToEmailAddresses(mail.cc),
    bcc: addressListToEmailAddresses(mail.bcc),
    replyTo: addressListToEmailAddresses(mail.replyTo),
    subject: mail.subject ?? null,
    date: mail.date ? mail.date.toISOString() : null,
    returnPath: rawHeaderValue(headerLines, "return-path"),
    received: rawHeaderValues(headerLines, "received"),
    mimeVersion: rawHeaderValue(headerLines, "mime-version"),
    contentType: rawHeaderValue(headerLines, "content-type"),
    authenticationResults: rawHeaderValue(headerLines, "authentication-results"),
    dkim: rawHeaderValue(headerLines, "dkim-signature"),
    spf: rawHeaderValue(headerLines, "received-spf"),
    plainText: mail.text ?? null,
    htmlText: typeof mail.html === "string" ? mail.html : null,
    headersRaw: mail.headerLines.map(h => h.line).join("\n"),
    attachments: mail.attachments.map(a => ({
      filename: a.filename ?? "attachment",
      contentType: a.contentType ?? null,
      contentId: a.cid ?? null,
      isInline: a.contentDisposition === "inline",
      size: a.size ?? a.content.length,
      content: a.content,
    })),
  };
}
