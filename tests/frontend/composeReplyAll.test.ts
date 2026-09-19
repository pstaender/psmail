import { describe, expect, test } from "bun:test";
import { replyAllDraft, replyDraft } from "../../src/lib/compose";
import type { EmailRecord } from "../../src/server/types";

const email = (overrides: Partial<EmailRecord> = {}) =>
  ({
    subject: "Plan",
    from: [{ name: "Alice", address: "alice@example.com" }],
    to: [{ address: "me@example.com" }, { name: "Dora", address: "dora@example.com" }],
    cc: [{ name: "Carl", address: "carl@example.com" }],
    replyTo: [],
    date: "2026-01-01T10:00:00.000Z",
    messageId: "<1@example.com>",
    plainText: "Hello",
    ...overrides,
  }) as unknown as EmailRecord;

describe("replyAllDraft", () => {
  test("sender and the other To recipients go in To, the Cc recipients in Cc — without the account's own address", () => {
    const draft = replyAllDraft(email(), "me@example.com");
    expect(draft.to).toBe("Alice <alice@example.com>, Dora <dora@example.com>");
    expect(draft.cc).toBe("Carl <carl@example.com>");
    expect(draft.subject).toBe("Re: Plan");
    expect(draft.inReplyTo).toBe("<1@example.com>");
    expect(draft.body).toBe(replyDraft(email()).body); // same quote as a plain reply
  });

  test("the own address is matched case-insensitively, and nobody appears twice (an address in To isn't repeated in Cc)", () => {
    const draft = replyAllDraft(
      email({
        to: [{ address: "ME@Example.com" }, { address: "dora@example.com" }, { address: "ALICE@example.com" }],
        cc: [{ address: "dora@example.com" }, { address: "me@example.com" }, { address: "erin@example.com" }],
      }),
      "me@example.com"
    );
    expect(draft.to).toBe("Alice <alice@example.com>, dora@example.com");
    expect(draft.cc).toBe("erin@example.com");
  });

  test("honors Reply-To like a plain reply, and replying to your own message goes to its recipients", () => {
    expect(replyAllDraft(email({ replyTo: [{ address: "list@example.com" }] }), "me@example.com").to).toBe(
      "list@example.com, Dora <dora@example.com>"
    );
    const mine = email({ from: [{ address: "me@example.com" }], to: [{ address: "dora@example.com" }], cc: [] });
    const draft = replyAllDraft(mine, "me@example.com");
    expect(draft.to).toBe("dora@example.com");
    expect(draft.cc).toBe("");
  });
});
