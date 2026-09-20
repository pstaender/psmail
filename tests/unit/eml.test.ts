import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import { buildStoredEml, emlFileName, zipStream, type ZipEntry } from "../../src/server/services/eml";
import type { AttachmentRecord, EmailRecord } from "../../src/server/types";

async function* entries(list: ZipEntry[]) {
  for (const entry of list) yield entry;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** A minimal zip reader (central directory, deflate/stored) — independent of the writer under test. */
function readZip(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const files: { name: string; data: Buffer; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const method = zip.readUInt16LE(pos + 10);
    const crc = zip.readUInt32LE(pos + 16);
    const csize = zip.readUInt32LE(pos + 20);
    const usize = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const offset = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(start, start + csize);
    const data = method === 8 ? Buffer.from(Bun.inflateSync(body as Uint8Array<ArrayBuffer>)) : Buffer.from(body);
    expect(data.length).toBe(usize);
    files.push({ name, data, crc });
    pos += 46 + nameLen;
  }
  return files;
}

describe("zipStream", () => {
  const date = new Date(2024, 4, 1, 12, 30, 10);

  test("writes a zip that reads back: names (also non-ASCII), contents, checksums", async () => {
    const compressible = Buffer.from("hello mail\r\n".repeat(500));
    const tiny = Buffer.from("x");
    const zip = await collect(zipStream(entries([
      { name: "a.eml", data: compressible, date },
      { name: "Grüße ✉.eml", data: tiny, date }, // too small to gain from deflate: stored
      { name: "empty.eml", data: Buffer.alloc(0), date },
    ])));

    const files = readZip(zip);
    expect(files.map(f => f.name)).toEqual(["a.eml", "Grüße ✉.eml", "empty.eml"]);
    expect(files[0]!.data.equals(compressible)).toBe(true);
    expect(files[1]!.data.equals(tiny)).toBe(true);
    expect(files[2]!.data.length).toBe(0);
    for (const f of files) expect(f.crc).toBe(Bun.hash.crc32(f.data));
    expect(zip.length).toBeLessThan(compressible.length); // it really is compressed
  });

  test("an empty archive is still a valid zip", async () => {
    const zip = await collect(zipStream(entries([])));
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  test("entries are pulled one at a time, and abandoning the stream stops the source and lets it clean up", async () => {
    const log: string[] = [];
    async function* source(): AsyncGenerator<ZipEntry> {
      try {
        for (const n of [1, 2, 3, 4]) {
          log.push(`make ${n}`);
          yield { name: `${n}.eml`, data: Buffer.from(String(n)), date };
        }
      } finally {
        log.push("closed");
      }
    }
    const reader = zipStream(source()).getReader();
    await reader.read(); // first entry's header
    await reader.read(); // its data
    expect(log.filter(l => l.startsWith("make")).length).toBeLessThanOrEqual(2); // not the whole selection up front
    await reader.cancel();
    expect(log).toContain("closed");
  });

  test("a source that fails breaks the stream instead of delivering a corrupt archive", async () => {
    async function* failing(): AsyncGenerator<ZipEntry> {
      yield { name: "1.eml", data: Buffer.from("1"), date };
      throw new Error("disk gone");
    }
    await expect(collect(zipStream(failing()))).rejects.toThrow("disk gone");
  });
});

describe("emlFileName", () => {
  test("date and subject, made safe for file systems", () => {
    const used = new Set<string>();
    expect(emlFileName({ id: 1, subject: "Re: Hello / World?", date: "2024-05-01T10:00:00Z" }, used)).toBe("2024-05-01 Re_ Hello _ World_.eml");
    expect(emlFileName({ id: 2, subject: null, date: null }, used)).toBe("message 2.eml");
    expect(emlFileName({ id: 3, subject: "  ..hidden  ", date: "garbage" }, used)).toBe("hidden.eml");
  });

  test("same names get numbered, in any case, and long subjects are cut", () => {
    const used = new Set<string>();
    const mail = { id: 1, subject: "Invoice", date: "2024-05-01T10:00:00Z" };
    expect(emlFileName(mail, used)).toBe("2024-05-01 Invoice.eml");
    expect(emlFileName({ ...mail, subject: "INVOICE" }, used)).toBe("2024-05-01 INVOICE (2).eml");
    expect(emlFileName(mail, used)).toBe("2024-05-01 Invoice (3).eml");
    expect(emlFileName({ ...mail, subject: "x".repeat(300) }, used).length).toBeLessThan(100);
  });
});

describe("buildStoredEml", () => {
  const email = {
    id: 1,
    from: [{ name: "Alice", address: "alice@example.com" }],
    to: [{ name: "", address: "bob@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "Grüße",
    date: "2024-05-01T10:00:00.000Z",
    messageId: "<abc@example.com>",
    inReplyTo: "<prev@example.com>",
    plainText: "Hello Bob",
    htmlText: "<p>Hello <b>Bob</b></p>",
  } as unknown as EmailRecord;

  test("renders headers, both bodies and attachments so that a mail client reads them back", async () => {
    const record = { id: 1, filename: "note.txt", contentType: "text/plain", contentId: null, isInline: false } as AttachmentRecord;
    const parsed = await simpleParser(await buildStoredEml(email, [{ record, content: Buffer.from("attached") }]));

    expect(parsed.subject).toBe("Grüße");
    expect(parsed.from?.value[0]).toMatchObject({ name: "Alice", address: "alice@example.com" });
    expect(parsed.to).toMatchObject({ value: [{ address: "bob@example.com" }] });
    expect(parsed.messageId).toBe("<abc@example.com>");
    expect(parsed.inReplyTo).toBe("<prev@example.com>");
    expect(parsed.date?.toISOString()).toBe("2024-05-01T10:00:00.000Z");
    expect(parsed.text).toContain("Hello Bob");
    expect(parsed.html).toContain("<b>Bob</b>");
    expect(parsed.attachments.map(a => [a.filename, a.content.toString()])).toEqual([["note.txt", "attached"]]);
    expect(parsed.headers.get("x-psmail-reconstructed")).toBeTruthy(); // says it isn't the original
  });
});
