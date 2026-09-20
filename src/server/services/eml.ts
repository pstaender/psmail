import MailComposer from "nodemailer/lib/mail-composer";
import type { AttachmentRecord, EmailAddress, EmailRecord } from "../types";

/**
 * Downloading messages as .eml files: the message itself (RFC 822 source) as one file, or many of them in a zip
 * that is streamed — each message is read, written into the stream and forgotten before the next one, so the
 * memory used doesn't grow with the size of the selection.
 */

const formatAddress = (a: EmailAddress) => (a.name ? `"${a.name.replace(/"/g, '\\"')}" <${a.address}>` : a.address);
const formatList = (list: EmailAddress[]) => (list.length > 0 ? list.map(formatAddress).join(", ") : undefined);

/**
 * Builds a message from what is stored, for messages whose original can't be fetched (a draft, a sent message that
 * was never copied to the server, a disabled account, an unreachable server). It's a faithful rendering — headers,
 * text, HTML, attachments — but not the original bytes (the server's Received chain and the exact MIME layout are
 * not kept), which is why it says so in an X-PSMail-Reconstructed header.
 */
export async function buildStoredEml(email: EmailRecord, attachments: { record: AttachmentRecord; content: Buffer }[]): Promise<Buffer> {
  return new MailComposer({
    from: email.from.length > 0 ? formatList(email.from) : undefined,
    to: formatList(email.to),
    cc: formatList(email.cc),
    bcc: formatList(email.bcc),
    replyTo: formatList(email.replyTo),
    subject: email.subject ?? "",
    date: email.date ? new Date(email.date) : undefined,
    messageId: email.messageId ?? undefined,
    inReplyTo: email.inReplyTo ?? undefined,
    text: email.plainText ?? undefined,
    html: email.htmlText ?? undefined,
    headers: { "X-PSMail-Reconstructed": "from the stored message; not the server's original" },
    attachments: attachments.map(({ record, content }) => ({
      filename: record.filename,
      content,
      contentType: record.contentType ?? undefined,
      cid: record.contentId ?? undefined,
      contentDisposition: record.isInline ? "inline" : "attachment",
    })),
  }).compile().build();
}

/** "2024-05-01 Subject.eml": safe on every file system, and unique among `used` (which it adds to). */
export function emlFileName(email: { id: number; subject: string | null; date: string | null }, used: Set<string>): string {
  const day = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString().slice(0, 10) : "";
  const subject = (email.subject ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  const base = [day, subject || `message ${email.id}`].filter(Boolean).join(" ");

  let name = `${base}.eml`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).eml`;
  used.add(name.toLowerCase());
  return name;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  date: Date;
}

const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** The limits of a plain (non-ZIP64) zip archive. */
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

/**
 * A zip archive as a stream, written one entry at a time: an entry is compressed (deflate; stored as is when that
 * doesn't help), written and released before the next one is asked for. Only the small directory of names, sizes and
 * offsets is kept until the end. The stream errors (and the download breaks, rather than delivering a corrupt file)
 * beyond the limits of a plain zip — 65535 entries or 4 GB.
 */
export function zipStream(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const iterator = entries[Symbol.asyncIterator]();
  const directory: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();

        if (next.done) {
          const directoryStart = offset;
          const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
          for (const part of directory) controller.enqueue(part);
          controller.enqueue(
            new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(directory.length), ...u16(directory.length), ...u32(directorySize), ...u32(directoryStart), ...u16(0)])
          );
          controller.close();
          return;
        }

        const { name, data, date } = next.value;
        if (directory.length >= MAX_ENTRIES) throw new Error("Too many messages for one zip file.");
        const nameBytes = encoder.encode(name);
        const deflated = Bun.deflateSync(data as Uint8Array<ArrayBuffer>);
        const stored = deflated.length >= data.length;
        const body = stored ? data : deflated;
        const method = stored ? 0 : 8;
        const crc = Bun.hash.crc32(data);
        const { time, day } = dosDateTime(date);
        const common = [...u16(0x0800), ...u16(method), ...u16(time), ...u16(day), ...u32(crc), ...u32(body.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0)];

        const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...common, ...nameBytes]);
        if (offset + local.length + body.length > MAX_BYTES) throw new Error("The messages are too big for one zip file.");
        directory.push(
          new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes])
        );
        offset += local.length + body.length;
        controller.enqueue(local);
        controller.enqueue(body);
      } catch (error) {
        await iterator.return?.();
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
