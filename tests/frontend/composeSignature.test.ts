import { describe, expect, test } from "bun:test";
import { forwardDraft, replyDraft, withSignature } from "../../src/lib/compose";
import type { EmailRecord } from "../../src/server/types";

const email = {
  subject: "Hello",
  from: [{ name: "Alice", address: "alice@example.com" }],
  to: [{ address: "me@example.com" }],
  replyTo: [],
  date: "2026-01-01T10:00:00.000Z",
  messageId: "<1@example.com>",
  plainText: "Line one\nLine two",
} as unknown as EmailRecord;

const SIGNATURE = "Cheers,\nMe";

describe("withSignature", () => {
  test("a reply gets the signature above the quoted original, after the blank space to type in", () => {
    const body = withSignature(replyDraft(email), SIGNATURE).body!;
    expect(body.startsWith("\n\n-- \nCheers,\nMe\n\nOn ")).toBe(true);
    expect(body.indexOf("-- \nCheers")).toBeLessThan(body.indexOf("> Line one"));
    expect(body.endsWith("> Line one\n> Line two")).toBe(true);
  });

  test("a forward gets the signature above the forwarded message", () => {
    const body = withSignature(forwardDraft(email), SIGNATURE).body!;
    expect(body.startsWith("\n\n-- \nCheers,\nMe\n\n---------- Forwarded message ----------")).toBe(true);
    expect(body.endsWith("Line one\nLine two")).toBe(true);
  });

  test("a new message still just gets the signature", () => {
    expect(withSignature(null, SIGNATURE).body).toBe("\n\n-- \nCheers,\nMe");
  });

  test("without a signature, replies and forwards keep their quoted body untouched", () => {
    expect(withSignature(replyDraft(email), null).body).toBe(replyDraft(email).body);
    expect(withSignature(forwardDraft(email), "").body).toBe(forwardDraft(email).body);
  });
});
