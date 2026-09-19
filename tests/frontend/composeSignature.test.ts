import { describe, expect, test } from "bun:test";
import { forwardDraft, joinRefined, replyDraft, splitRefinable, withSignature } from "../../src/lib/compose";
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

describe("splitRefinable / joinRefined (what the AI Refine may rewrite)", () => {
  test("only the part you wrote is refined: not the signature, the quoted original, or a forwarded message", () => {
    const signed = splitRefinable("Hi Bob,\nsee attached\n\n-- \nCheers\nMe");
    expect(signed.head).toBe("Hi Bob,\nsee attached\n");
    expect(signed.tail).toBe("\n-- \nCheers\nMe");

    const reply = splitRefinable("Thanks!\n\nOn Monday, Alice wrote:\n> Hello\n> there");
    expect(reply.head).toBe("Thanks!\n");
    expect(reply.tail.startsWith("\nOn Monday, Alice wrote:")).toBe(true);

    expect(splitRefinable("Please see below.\n\n---------- Forwarded message ----------\nFrom: x").head).toBe("Please see below.\n");
    expect(splitRefinable("Just a note").tail).toBe("");
  });

  test("a draft that starts with the signature or quote has nothing of its own to refine", () => {
    expect(splitRefinable("\n\n-- \nCheers").head.trim()).toBe("");
    expect(splitRefinable("\n\nOn Monday, Alice wrote:\n> Hello").head.trim()).toBe("");
  });

  test("the result goes back between the same whitespace, in front of the untouched tail", () => {
    const parts = splitRefinable("\nhi bob\n\n-- \nCheers");
    expect(joinRefined(parts, "  Hello Bob,  ")).toBe("\nHello Bob,\n\n-- \nCheers");
    expect(joinRefined(splitRefinable("only text"), "Only text.")).toBe("Only text.");
  });
});
