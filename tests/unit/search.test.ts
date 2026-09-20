import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount } from "../../src/server/models/accounts";
import { createEmail } from "../../src/server/models/emails";
import { parseSearchQuery, searchEmails } from "../../src/server/models/search";

describe("parseSearchQuery", () => {
  test("splits bare words into independent AND'd general terms", () => {
    expect(parseSearchQuery("amazon gutschein")).toEqual({
      generalTerms: ["amazon", "gutschein"],
      fromTerms: [],
      favsOnly: false,
    });
  });

  test("keeps a quoted phrase as one term instead of splitting it", () => {
    expect(parseSearchQuery('"Mountain Bike"')).toEqual({
      generalTerms: ["Mountain Bike"],
      fromTerms: [],
      favsOnly: false,
    });
  });

  test("extracts from: as a separate, ORed filter", () => {
    expect(parseSearchQuery("from:alice@example.com amazon*gutschein")).toEqual({
      generalTerms: ["amazon*gutschein"],
      fromTerms: ["alice@example.com"],
      favsOnly: false,
    });
  });

  test("supports a quoted phrase after from:", () => {
    expect(parseSearchQuery('from:"jane doe" hello')).toEqual({
      generalTerms: ["hello"],
      fromTerms: ["jane doe"],
      favsOnly: false,
    });
  });

  test("multiple from: terms are collected (matched with OR)", () => {
    expect(parseSearchQuery("from:alice@x.com from:bob@x.com")).toEqual({
      generalTerms: [],
      fromTerms: ["alice@x.com", "bob@x.com"],
      favsOnly: false,
    });
  });

  test("a leading `favs` is a command, not a search term; the rest filters as usual", () => {
    expect(parseSearchQuery("favs amazon from:bob")).toEqual({ generalTerms: ["amazon"], fromTerms: ["bob"], favsOnly: true });
    expect(parseSearchQuery("FAVS")).toEqual({ generalTerms: [], fromTerms: [], favsOnly: true });
  });

  test("`favs` anywhere but first, inside a longer word, or quoted is an ordinary term", () => {
    expect(parseSearchQuery("amazon favs").favsOnly).toBe(false);
    expect(parseSearchQuery("favsfoo").favsOnly).toBe(false);
    expect(parseSearchQuery('"favs" x')).toEqual({ generalTerms: ["favs", "x"], fromTerms: [], favsOnly: false });
  });
});

async function setupTwoAccountsWithEmails(db: ReturnType<typeof createTestDb>) {
  const user = await createUser(db, "alice", "pw");
  const key = deriveEncryptionKey("pw", generateSalt());

  const accountA = createAccount(
    db,
    user.id,
    {
      email: "work@example.com",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecure: true,
      imapUsername: "work@example.com",
      imapPassword: "x",
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      smtpUsername: "work@example.com",
      smtpPassword: "x",
    },
    key
  );
  const accountB = createAccount(
    db,
    user.id,
    {
      email: "personal@example.com",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecure: true,
      imapUsername: "personal@example.com",
      imapPassword: "x",
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      smtpUsername: "personal@example.com",
      smtpPassword: "x",
    },
    key
  );

  createEmail(db, accountA.id, {
    folder: "INBOX",
    uid: 1,
    isDraft: false,
    subject: "Amazon Gutschein für dich – 20% Rabatt",
    from: [{ name: "Amazon", address: "no-reply@amazon.de" }],
    date: "2024-01-03T00:00:00.000Z",
  });
  createEmail(db, accountA.id, {
    folder: "Archive",
    uid: 2,
    isDraft: false,
    subject: "Your invoice #123",
    from: [{ name: "Billing", address: "billing@example.com" }],
    date: "2024-01-02T00:00:00.000Z",
  });
  createEmail(db, accountB.id, {
    folder: "INBOX",
    uid: 1,
    isDraft: false,
    subject: "Neues Mountain Bike verfügbar",
    from: [{ name: "Alice Ständer", address: "alice@example.com" }],
    date: "2024-01-04T00:00:00.000Z",
  });
  createEmail(db, accountB.id, {
    folder: "INBOX",
    uid: 2,
    isDraft: false,
    subject: "Mountain view apartment listing",
    from: [{ address: "listings@example.com" }],
    date: "2024-01-01T00:00:00.000Z",
  });

  return { user, accountA, accountB };
}

describe("searchEmails", () => {
  test("searches subjects across every account the user owns, case-insensitively", async () => {
    const db = createTestDb();
    const { user } = await setupTwoAccountsWithEmails(db);

    const results = searchEmails(db, user.id, "AMAZON");
    expect(results).toHaveLength(1);
    expect(results[0]!.subject).toContain("Amazon Gutschein");
    expect(results[0]!.accountEmail).toBe("work@example.com");
  });

  test("bare multi-word query ANDs independent terms regardless of order", async () => {
    const db = createTestDb();
    const { user } = await setupTwoAccountsWithEmails(db);

    expect(searchEmails(db, user.id, "gutschein amazon")).toHaveLength(1);
    expect(searchEmails(db, user.id, "amazon invoice")).toHaveLength(0); // no single subject has both
  });

  test('a quoted phrase matches only the exact contiguous phrase', async () => {
    const db = createTestDb();
    const { user } = await setupTwoAccountsWithEmails(db);

    const exact = searchEmails(db, user.id, '"Mountain Bike"');
    expect(exact).toHaveLength(1);
    expect(exact[0]!.subject).toContain("Mountain Bike");

    // Without quotes, "mountain" and "bike" are independent AND'd terms, so
    // "Mountain view apartment" (which has neither "bike") is excluded, but a
    // subject containing both words non-adjacently would also match — unlike the phrase.
    const looseAnd = searchEmails(db, user.id, "mountain bike");
    expect(looseAnd).toHaveLength(1);
  });

  test("supports wildcard * spanning arbitrary text", async () => {
    const db = createTestDb();
    const { user } = await setupTwoAccountsWithEmails(db);

    // "Amazon Gutschein für dich – 20% Rabatt" ends with "Rabatt" but NOT with "Gutschein" —
    // the match must not require the whole subject to end exactly at the pattern's tail.
    expect(searchEmails(db, user.id, "amazon*gutschein")).toHaveLength(1);
    expect(searchEmails(db, user.id, "amazon*rabatt")).toHaveLength(1);
    expect(searchEmails(db, user.id, "amazon*doesnotexist")).toHaveLength(0);
  });

  test("from: filters by sender name or address, combinable with a subject term", async () => {
    const db = createTestDb();
    const { user } = await setupTwoAccountsWithEmails(db);

    expect(searchEmails(db, user.id, "from:alice@example.com")).toHaveLength(1);
    expect(searchEmails(db, user.id, "from:ständer")).toHaveLength(1); // matches the display name, case-insensitively incl. umlaut
    expect(searchEmails(db, user.id, "from:alice@example.com bike")).toHaveLength(1);
    expect(searchEmails(db, user.id, "from:alice@example.com invoice")).toHaveLength(0);
  });

  test("never returns another user's emails", async () => {
    const db = createTestDb();
    await setupTwoAccountsWithEmails(db);
    const otherUser = await createUser(db, "bob", "pw");

    expect(searchEmails(db, otherUser.id, "amazon")).toHaveLength(0);
  });

  test("an empty query returns no results", async () => {
    const db = createTestDb();
    const { user } = await setupTwoAccountsWithEmails(db);

    expect(searchEmails(db, user.id, "")).toHaveLength(0);
    expect(searchEmails(db, user.id, "   ")).toHaveLength(0);
  });

  test("results are ordered newest first and paginate", async () => {
    const db = createTestDb();
    const { user } = await setupTwoAccountsWithEmails(db);

    const all = searchEmails(db, user.id, "mountain");
    expect(all.map(r => r.date)).toEqual(["2024-01-04T00:00:00.000Z", "2024-01-01T00:00:00.000Z"]);

    const page1 = searchEmails(db, user.id, "mountain", { limit: 1, offset: 0 });
    const page2 = searchEmails(db, user.id, "mountain", { limit: 1, offset: 1 });
    expect(page1.map(r => r.id)).not.toEqual(page2.map(r => r.id));
  });

  describe("bare terms also match the sender (not just the subject)", () => {
    async function setupAmazonScenario(db: ReturnType<typeof createTestDb>) {
      const user = await createUser(db, "carol", "pw");
      const key = deriveEncryptionKey("pw", generateSalt());
      const account = createAccount(
        db,
        user.id,
        {
          email: "me@example.com",
          imapHost: "imap.example.com",
          imapPort: 993,
          imapSecure: true,
          imapUsername: "me@example.com",
          imapPassword: "x",
          smtpHost: "smtp.example.com",
          smtpPort: 465,
          smtpSecure: true,
          smtpUsername: "me@example.com",
          smtpPassword: "x",
        },
        key
      );

      // "amazon" appears only in the sender address, nowhere in the subject.
      createEmail(db, account.id, {
        folder: "INBOX",
        uid: 1,
        isDraft: false,
        subject: "Your order has shipped",
        from: [{ address: "shipping@amazon.de" }],
        date: "2024-02-01T00:00:00.000Z",
      });
      // Same: "amazon" only in the sender; subject has both other words.
      createEmail(db, account.id, {
        folder: "INBOX",
        uid: 2,
        isDraft: false,
        subject: "Neues Fahrrad + Gutscheine warten auf dich",
        from: [{ address: "deals@amazon.de" }],
        date: "2024-02-02T00:00:00.000Z",
      });
      // Unrelated: no "amazon" anywhere.
      createEmail(db, account.id, {
        folder: "INBOX",
        uid: 3,
        isDraft: false,
        subject: "Team lunch on Friday",
        from: [{ address: "colleague@example.com" }],
        date: "2024-02-03T00:00:00.000Z",
      });

      return { user };
    }

    test("a bare word alone matches sender-only occurrences, not just the subject", async () => {
      const db = createTestDb();
      const { user } = await setupAmazonScenario(db);

      const results = searchEmails(db, user.id, "amazon");
      expect(results).toHaveLength(2);
      expect(results.map(r => r.subject).sort()).toEqual(
        ["Neues Fahrrad + Gutscheine warten auf dich", "Your order has shipped"].sort()
      );
    });

    test('"amazon gutscheine fahrrad" = from has amazon AND subject has gutscheine AND subject has fahrrad', async () => {
      const db = createTestDb();
      const { user } = await setupAmazonScenario(db);

      const results = searchEmails(db, user.id, "amazon gutscheine fahrrad");
      expect(results).toHaveLength(1);
      expect(results[0]!.subject).toBe("Neues Fahrrad + Gutscheine warten auf dich");
    });

    test("still requires every word to match — a word absent from both subject and sender excludes it", async () => {
      const db = createTestDb();
      const { user } = await setupAmazonScenario(db);

      expect(searchEmails(db, user.id, "amazon lunch")).toHaveLength(0);
    });

    test("explicit from: stays sender-only and doesn't start matching the subject", async () => {
      const db = createTestDb();
      const { user } = await setupAmazonScenario(db);

      // "fahrrad" only appears in a subject, never in any sender — from:fahrrad must match nothing.
      expect(searchEmails(db, user.id, "from:fahrrad")).toHaveLength(0);
    });
  });
});

describe("search: falling back to the message text", () => {
  async function mailbox() {
    const db = createTestDb();
    const user = await createUser(db, "alice", "pw");
    const key = deriveEncryptionKey("pw", generateSalt());
    const account = createAccount(
      db,
      user.id,
      { email: "a@x.com", imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: "a", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: "a", smtpPassword: "x" },
      key
    );
    const mail = (subject: string, plainText: string | null, date: string, extra = {}) =>
      createEmail(db, account.id, { folder: "INBOX", isDraft: false, subject, plainText, date, from: [{ name: "Sender", address: "s@y.com" }], ...extra });
    return { db, user, mail };
  }

  test("a query that matches no subject or sender finds messages by their text, marked as such", async () => {
    const { db, user, mail } = await mailbox();
    mail("Unterlagen", "Bitte senden Sie die Belege bis Ende September.", "2026-01-02T00:00:00.000Z");
    mail("Hallo", "Nichts Besonderes.", "2026-01-03T00:00:00.000Z");

    const results = searchEmails(db, user.id, "belege");
    expect(results.map(r => r.subject)).toEqual(["Unterlagen"]);
    expect(results[0]!.matchedInBody).toBe(true);
  });

  test("subject and sender hits come first and alone: the text is only searched when they found nothing", async () => {
    const { db, user, mail } = await mailbox();
    mail("Invoice May", "irrelevant", "2026-01-01T00:00:00.000Z");
    mail("Other", "please pay the invoice today", "2026-01-02T00:00:00.000Z");

    const results = searchEmails(db, user.id, "invoice");
    expect(results.map(r => r.subject)).toEqual(["Invoice May"]);
    expect(results[0]!.matchedInBody).toBeUndefined();
  });

  test("terms are still ANDed — each in the subject, the sender or the text — and wildcards, phrases and Unicode work", async () => {
    const { db, user, mail } = await mailbox();
    mail("Termin", "Wir treffen uns im Café am Marktplatz um 14 Uhr.", "2026-01-01T00:00:00.000Z");
    mail("Termin", "Wir treffen uns im Büro.", "2026-01-02T00:00:00.000Z");

    expect(searchEmails(db, user.id, "café marktplatz").map(r => r.id)).toHaveLength(1);
    expect(searchEmails(db, user.id, "CAFÉ").map(r => r.matchedInBody)).toEqual([true]); // case-insensitive, non-ASCII
    expect(searchEmails(db, user.id, '"am Marktplatz"')).toHaveLength(1);
    expect(searchEmails(db, user.id, "treffen*Büro")).toHaveLength(1);
    expect(searchEmails(db, user.id, "treffen zzz")).toEqual([]); // one term nowhere: nothing
    expect(searchEmails(db, user.id, "termin marktplatz")).toHaveLength(1); // one in the subject, one in the text
  });

  test("from: and favs still restrict, and a query without general terms doesn't read bodies at all", async () => {
    const { db, user, mail } = await mailbox();
    mail("A", "the secret word", "2026-01-01T00:00:00.000Z", { from: [{ name: "Bob", address: "bob@y.com" }] });
    mail("B", "the secret word", "2026-01-02T00:00:00.000Z", { from: [{ name: "Cy", address: "cy@y.com" }], isFlagged: true });

    expect(searchEmails(db, user.id, "secret from:bob").map(r => r.subject)).toEqual(["A"]);
    expect(searchEmails(db, user.id, "favs secret").map(r => r.subject)).toEqual(["B"]);
    expect(searchEmails(db, user.id, "from:nobody")).toEqual([]);
  });

  test("newest first, paged; messages without a plain text part are skipped", async () => {
    const { db, user, mail } = await mailbox();
    for (let i = 1; i <= 5; i++) mail(`M${i}`, `contains needle ${i}`, `2026-01-0${i}T00:00:00.000Z`);
    mail("HTML only", null, "2026-01-09T00:00:00.000Z");

    expect(searchEmails(db, user.id, "needle").map(r => r.subject)).toEqual(["M5", "M4", "M3", "M2", "M1"]);
    expect(searchEmails(db, user.id, "needle", { limit: 2, offset: 2 }).map(r => r.subject)).toEqual(["M3", "M2"]);
    expect(searchEmails(db, user.id, "needle", { limit: 2, offset: 4 }).map(r => r.subject)).toEqual(["M1"]);
  });

  test("it only ever sees the user's own mail", async () => {
    const { db, mail } = await mailbox();
    mail("Mine", "shared word", "2026-01-01T00:00:00.000Z");
    const other = await createUser(db, "bob", "pw");
    expect(searchEmails(db, other.id, "shared")).toEqual([]);
  });
});

describe("search: full text (the message text is always searched)", () => {
  async function box() {
    const db = createTestDb();
    const user = await createUser(db, "alice", "pw");
    const key = deriveEncryptionKey("pw", generateSalt());
    const account = createAccount(
      db,
      user.id,
      { email: "a@x.com", imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: "a", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: "a", smtpPassword: "x" },
      key
    );
    const mail = (subject: string, plainText: string | null, date: string) =>
      createEmail(db, account.id, { folder: "INBOX", isDraft: false, subject, plainText, date, from: [{ name: "Sender", address: "s@y.com" }] });
    return { db, user, mail };
  }

  test("without it the text is only searched when subject and sender found nothing; with it, always", async () => {
    const { db, user, mail } = await box();
    mail("Invoice May", "irrelevant", "2026-01-01T00:00:00.000Z");
    mail("Reminder", "please pay the invoice today", "2026-01-02T00:00:00.000Z");

    expect(searchEmails(db, user.id, "invoice").map(r => r.subject)).toEqual(["Invoice May"]);
    expect(searchEmails(db, user.id, "invoice", { fullText: true }).map(r => r.subject)).toEqual(["Reminder", "Invoice May"]);
  });

  test("a message found by both is listed once, as a subject hit; only text hits are marked as such", async () => {
    const { db, user, mail } = await box();
    mail("Invoice", "the invoice text", "2026-01-01T00:00:00.000Z");
    mail("Other", "an invoice too", "2026-01-02T00:00:00.000Z");

    const results = searchEmails(db, user.id, "invoice", { fullText: true });
    expect(results.map(r => [r.subject, r.matchedInBody])).toEqual([["Other", true], ["Invoice", undefined]]);
  });

  test("terms are ANDed across subject, sender and text; a message without plain text can still match by its subject", async () => {
    const { db, user, mail } = await box();
    mail("Termin", "Treffen am Marktplatz", "2026-01-02T00:00:00.000Z");
    mail("Termin HTML only", null, "2026-01-01T00:00:00.000Z");

    expect(searchEmails(db, user.id, "termin marktplatz", { fullText: true }).map(r => r.subject)).toEqual(["Termin"]);
    expect(searchEmails(db, user.id, "termin", { fullText: true }).map(r => r.subject)).toEqual(["Termin", "Termin HTML only"]);
  });

  test("paging over the merged list, and the date window", async () => {
    const { db, user, mail } = await box();
    for (let i = 1; i <= 6; i++) mail(i % 2 ? `Note ${i}` : `Other ${i}`, `a note about ${i}`, `2026-01-0${i}T00:00:00.000Z`);

    expect(searchEmails(db, user.id, "note", { fullText: true }).map(r => r.subject)).toEqual(["Other 6", "Note 5", "Other 4", "Note 3", "Other 2", "Note 1"]);
    expect(searchEmails(db, user.id, "note", { fullText: true, limit: 2, offset: 2 }).map(r => r.subject)).toEqual(["Other 4", "Note 3"]);
    expect(searchEmails(db, user.id, "note", { fullText: true, before: "2026-01-04T00:00:00.000Z" }).map(r => r.subject)).toEqual(["Note 3", "Other 2", "Note 1"]);
  });
});
