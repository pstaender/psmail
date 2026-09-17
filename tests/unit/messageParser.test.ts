import { describe, expect, test } from "bun:test";
import { parseMessage } from "../../src/server/services/messageParser";

const RAW_MESSAGE = [
  "Return-Path: <sender@example.com>",
  "Received: from mx2.example.com by mx1.example.net; Mon, 01 Jan 2024 10:00:00 +0000",
  "Received: from client.example.com by mx2.example.com; Mon, 01 Jan 2024 09:59:00 +0000",
  "MIME-Version: 1.0",
  "From: \"Alice Sender\" <sender@example.com>",
  "To: recipient@example.com",
  "Cc: cc-person@example.com",
  "Subject: Test message with attachment",
  "Date: Mon, 01 Jan 2024 10:00:00 +0000",
  "Message-ID: <abc123@example.com>",
  "Authentication-Results: mx.example.com; dkim=pass header.i=@example.com; spf=pass",
  "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=default; b=abc123",
  "Received-SPF: pass (example.com: domain of sender@example.com designates 1.2.3.4 as permitted sender)",
  'Content-Type: multipart/mixed; boundary="BOUNDARY"',
  "",
  "--BOUNDARY",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello, this is the plain text body.",
  "",
  "--BOUNDARY",
  'Content-Type: text/plain; name="note.txt"',
  "Content-Disposition: attachment; filename=\"note.txt\"",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("attachment contents").toString("base64"),
  "",
  "--BOUNDARY--",
  "",
].join("\r\n");

describe("parseMessage", () => {
  test("extracts headers, addresses, body and authentication info", async () => {
    const parsed = await parseMessage(Buffer.from(RAW_MESSAGE));

    expect(parsed.messageId).toBe("<abc123@example.com>");
    expect(parsed.from).toEqual([{ name: "Alice Sender", address: "sender@example.com" }]);
    expect(parsed.to).toEqual([{ address: "recipient@example.com" }]);
    expect(parsed.cc).toEqual([{ address: "cc-person@example.com" }]);
    expect(parsed.subject).toBe("Test message with attachment");
    expect(parsed.plainText?.trim()).toBe("Hello, this is the plain text body.");
    expect(parsed.returnPath).toBe("<sender@example.com>");
    expect(parsed.received).toHaveLength(2);
    expect(parsed.mimeVersion).toBe("1.0");
    expect(parsed.authenticationResults).toContain("dkim=pass");
    expect(parsed.dkim).toContain("d=example.com");
    expect(parsed.spf).toContain("pass");
  });

  test("extracts attachments with filename, content type and content", async () => {
    const parsed = await parseMessage(Buffer.from(RAW_MESSAGE));

    expect(parsed.attachments).toHaveLength(1);
    const attachment = parsed.attachments[0]!;
    expect(attachment.filename).toBe("note.txt");
    expect(attachment.isInline).toBe(false);
    expect(attachment.content.toString("utf8")).toBe("attachment contents");
  });
});
