import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import { composeMessage, type AttachmentWithData } from "../../src/server/services/smtp";
import type { EmailRecord } from "../../src/server/types";

const NOW = "2024-01-01T10:00:00.000Z";

function draftFixture(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 1,
    accountId: 1,
    folder: "Drafts",
    uid: null,
    isDraft: true,
    isRead: true,
    isFlagged: false,
    messageId: null,
    inReplyTo: null,
    from: [{ name: "Alice", address: "alice@example.com" }],
    to: [{ address: "bob@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "Hello",
    date: NOW,
    returnPath: null,
    received: [],
    mimeVersion: null,
    contentType: null,
    authenticationResults: null,
    dkim: null,
    spf: null,
    plainText: "Hi Bob",
    htmlText: "<p>Hi Bob</p>",
    headersRaw: null,
    size: null,
    taxonomyList: [],
    aiSummary: null,
    translatedText: null,
    translatedLanguage: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * `composeMessage` is a pure, network-free step (no SMTP connection), so it's verified by
 * actually parsing the raw MIME it builds back with mailparser — the same real library the
 * app uses to parse incoming mail — rather than mocking anything.
 */
describe("composeMessage", () => {
  test("builds a raw message whose headers/body round-trip through a real MIME parser", async () => {
    const composed = await composeMessage(draftFixture());
    const parsed = await simpleParser(composed.raw);

    expect(parsed.subject).toBe("Hello");
    expect(parsed.from?.value[0]).toMatchObject({ name: "Alice", address: "alice@example.com" });
    expect(parsed.to && "value" in parsed.to ? parsed.to.value[0] : undefined).toMatchObject({ address: "bob@example.com" });
    expect(parsed.text?.trim()).toBe("Hi Bob");
    expect(parsed.messageId).toBe(composed.messageId);
  });

  test("includes cc/bcc/reply-to and an attachment", async () => {
    const attachment: AttachmentWithData = {
      id: 1,
      emailId: 1,
      filename: "note.txt",
      contentType: "text/plain",
      contentId: null,
      isInline: false,
      size: 5,
      content: Buffer.from("hello"),
    };

    const composed = await composeMessage(
      draftFixture({ cc: [{ address: "carol@example.com" }], bcc: [{ address: "dave@example.com" }], replyTo: [{ address: "reply@example.com" }] }),
      [attachment]
    );
    const parsed = await simpleParser(composed.raw);

    expect(parsed.cc && "value" in parsed.cc ? parsed.cc.value[0] : undefined).toMatchObject({ address: "carol@example.com" });
    // bcc is intentionally not written into MIME headers (that's the point of bcc); the parser confirms it's absent.
    expect(parsed.headers.get("bcc")).toBeUndefined();
    expect(parsed.replyTo?.value[0]).toMatchObject({ address: "reply@example.com" });
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe("note.txt");
    expect(parsed.attachments[0]!.content.toString()).toBe("hello");
  });

  test("gives each message a unique Message-ID", async () => {
    const first = await composeMessage(draftFixture());
    const second = await composeMessage(draftFixture());
    expect(first.messageId).not.toBe(second.messageId);
  });
});
