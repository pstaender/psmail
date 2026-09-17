import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount } from "../../src/server/models/accounts";
import { createEmail } from "../../src/server/models/emails";
import { parseSearchQuery, searchEmails } from "../../src/server/models/search";

describe("parseSearchQuery", () => {
  test("splits bare words into independent AND'd subject terms", () => {
    expect(parseSearchQuery("amazon gutschein")).toEqual({
      subjectTerms: ["amazon", "gutschein"],
      fromTerms: [],
    });
  });

  test("keeps a quoted phrase as one term instead of splitting it", () => {
    expect(parseSearchQuery('"Mountain Bike"')).toEqual({
      subjectTerms: ["Mountain Bike"],
      fromTerms: [],
    });
  });

  test("extracts from: as a separate, ORed filter", () => {
    expect(parseSearchQuery("from:alice@example.com amazon*gutschein")).toEqual({
      subjectTerms: ["amazon*gutschein"],
      fromTerms: ["alice@example.com"],
    });
  });

  test("supports a quoted phrase after from:", () => {
    expect(parseSearchQuery('from:"jane doe" hello')).toEqual({
      subjectTerms: ["hello"],
      fromTerms: ["jane doe"],
    });
  });

  test("multiple from: terms are collected (matched with OR)", () => {
    expect(parseSearchQuery("from:alice@x.com from:bob@x.com")).toEqual({
      subjectTerms: [],
      fromTerms: ["alice@x.com", "bob@x.com"],
    });
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
});
