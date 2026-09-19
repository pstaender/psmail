import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount } from "../../src/server/models/accounts";
import { createEmail, updateEmail } from "../../src/server/models/emails";
import { normalizeSearchText, rebuildContactsIfEmpty, suggestContacts, tidyContactNames, tidyDisplayName } from "../../src/server/models/contacts";

async function setup() {
  const db = createTestDb();
  const user = await createUser(db, "alice", "pw");
  const key = deriveEncryptionKey("pw", generateSalt());
  const account = createAccount(
    db,
    user.id,
    {
      email: "me@example.com",
      imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: "me", imapPassword: "x",
      smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: "me", smtpPassword: "x",
    },
    key
  );
  return { db, account };
}

const received = (from: string, cc: string[] = [], date = "2026-01-01T00:00:00.000Z") => ({
  folder: "INBOX",
  isDraft: false,
  from: [{ address: from, name: from.split("@")[0] }],
  to: [{ address: "me@example.com" }],
  cc: cc.map(address => ({ address })),
  date,
});

describe("contacts autocomplete", () => {
  test("ranks senders first, then Cc'd people, then people only sent to; frequency then recency within a group", async () => {
    const { db, account } = await setup();

    createEmail(db, account.id, received("bob@x.com"));
    createEmail(db, account.id, received("bob@x.com"));
    createEmail(db, account.id, received("bea@x.com", ["carl@x.com"]));
    createEmail(db, account.id, {
      folder: "Sent",
      isDraft: false,
      from: [{ address: "me@example.com" }],
      to: [{ address: "dora@x.com" }],
      date: "2026-02-01T00:00:00.000Z",
    });

    expect(suggestContacts(db, account.id, "").map(c => c.address)).toEqual([
      "bob@x.com", // sender, seen twice
      "bea@x.com", // sender, seen once
      "carl@x.com", // Cc'd
      "dora@x.com", // only sent to
    ]);
  });

  test("matches an address prefix or the start of any word in the name, case-insensitively", async () => {
    const { db, account } = await setup();
    createEmail(db, account.id, {
      ...received("jane@corp.com"),
      from: [{ address: "jane@corp.com", name: "Jane van Dijk" }],
    });

    expect(suggestContacts(db, account.id, "JAN")).toHaveLength(1);
    expect(suggestContacts(db, account.id, "dijk")).toHaveLength(1);
    expect(suggestContacts(db, account.id, "corp")).toHaveLength(0); // not an address prefix or name word
    expect(suggestContacts(db, account.id, "zzz")).toHaveLength(0);
  });

  test("matches an address prefix even when the contact has no display name", async () => {
    const { db, account } = await setup();
    createEmail(db, account.id, { ...received("noname@x.com"), from: [{ address: "noname@x.com" }] });
    expect(suggestContacts(db, account.id, "nonam").map(c => c.address)).toEqual(["noname@x.com"]);
    expect(suggestContacts(db, account.id, "oname")).toEqual([]);
  });

  test("never suggests the account's own address, and ignores drafts until they're sent", async () => {
    const { db, account } = await setup();
    const draft = createEmail(db, account.id, {
      folder: "Drafts",
      from: [{ address: "me@example.com" }],
      to: [{ address: "eve@x.com" }, { address: "me@example.com" }],
    });
    expect(suggestContacts(db, account.id, "")).toEqual([]);

    updateEmail(db, draft.id, { isDraft: false, folder: "Sent" });
    expect(suggestContacts(db, account.id, "").map(c => c.address)).toEqual(["eve@x.com"]);
  });

  test("is scoped to the account and honors the limit", async () => {
    const { db, account } = await setup();
    for (let i = 0; i < 5; i++) createEmail(db, account.id, received(`p${i}@x.com`));
    expect(suggestContacts(db, account.id, "p", { limit: 3 })).toHaveLength(3);
    expect(suggestContacts(db, account.id + 1, "p")).toEqual([]);
  });

  test("rebuildContactsIfEmpty backfills from already-stored mail, and is a no-op afterwards", async () => {
    const { db, account } = await setup();
    createEmail(db, account.id, received("old@x.com"));
    db.exec("DELETE FROM contacts");

    rebuildContactsIfEmpty(db);
    expect(suggestContacts(db, account.id, "old").map(c => c.address)).toEqual(["old@x.com"]);

    rebuildContactsIfEmpty(db);
    expect(suggestContacts(db, account.id, "old")[0]!.fromCount).toBe(1);
  });
});

describe("contact search is forgiving about punctuation and word order", () => {
  test("a name wrapped in quotes is found without typing the quote, and shown without them", async () => {
    const { db, account } = await setup();
    createEmail(db, account.id, { ...received("flastname@example.com"), from: [{ address: "flastname@example.com", name: "'First Lastname'" }] });

    for (const typed of ["First", "first", "'First", "Lastname", "First Last", "lastname first", "first-last"]) {
      expect(suggestContacts(db, account.id, typed).map(c => c.address)).toEqual(["flastname@example.com"]);
    }
    expect(suggestContacts(db, account.id, "First")[0]!.name).toBe("First Lastname"); // stored tidy
    expect(suggestContacts(db, account.id, "Second")).toEqual([]);
    expect(suggestContacts(db, account.id, "irst")).toEqual([]); // still word *starts*, not anywhere
  });

  test("other punctuation in names (comma, dots, umlauts) doesn't get in the way either", async () => {
    const { db, account } = await setup();
    createEmail(db, account.id, { ...received("a@x.com"), from: [{ address: "a@x.com", name: '"Müller, Jürgen"' }] });
    createEmail(db, account.id, { ...received("b@x.com"), from: [{ address: "b@x.com", name: "J.R.R. Tolkien" }] });

    expect(suggestContacts(db, account.id, "Jürgen").map(c => c.address)).toEqual(["a@x.com"]);
    expect(suggestContacts(db, account.id, "müller jürgen").map(c => c.address)).toEqual(["a@x.com"]);
    expect(suggestContacts(db, account.id, "tolkien").map(c => c.address)).toEqual(["b@x.com"]);
  });

  test("an address prefix with punctuation still works (that's what addresses are made of)", async () => {
    const { db, account } = await setup();
    createEmail(db, account.id, { ...received("first.last@example.com"), from: [{ address: "first.last@example.com" }] });
    expect(suggestContacts(db, account.id, "first.l").map(c => c.address)).toEqual(["first.last@example.com"]);
  });

  test("tidyContactNames repairs contacts stored before names were normalized", async () => {
    const { db, account } = await setup();
    db.query("INSERT INTO contacts (account_id, address, name, name_lc, from_count, last_used) VALUES (?, 'zz@x.com', ?, ?, 1, '2026-01-01')")
      .run(account.id, "'Old Timer'", "'old timer'");
    expect(suggestContacts(db, account.id, "Old")).toEqual([]); // the bug

    tidyContactNames(db);
    expect(suggestContacts(db, account.id, "Old").map(c => [c.address, c.name])).toEqual([["zz@x.com", "Old Timer"]]);
  });

  test("helpers", () => {
    expect(normalizeSearchText("  'First-Last', Jr.  ")).toBe("first last jr");
    expect(tidyDisplayName(`  "'Quoted Name'" `)).toBe("Quoted Name");
    expect(tidyDisplayName("Conan O'Brien")).toBe("Conan O'Brien"); // inner quotes stay
  });
});

describe("suggestions from the user's other accounts", () => {
  const accountInput = (email: string) => ({
    email, imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: "u", imapPassword: "x",
    smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: "u", smtpPassword: "x",
  });
  async function twoAccounts() {
    const db = createTestDb();
    const user = await createUser(db, "alice", "pw");
    const key = deriveEncryptionKey("pw", generateSalt());
    const make = (email: string) => createAccount(db, user.id, accountInput(email), key);
    return { db, user, key, a: make("a@example.com"), b: make("b@example.com"), make };
  }
  const mailFrom = (address: string, name = "") => ({ ...received(address), from: [{ address, name }] });

  test("by default only this account's contacts; with the option the others follow, marked and never repeated", async () => {
    const { db, a, b } = await twoAccounts();
    createEmail(db, a.id, mailFrom("anna@x.com", "Anna"));
    createEmail(db, b.id, mailFrom("anton@x.com", "Anton"));
    createEmail(db, b.id, mailFrom("anna@x.com", "Anna B")); // the same person known to both

    expect(suggestContacts(db, a.id, "an").map(c => c.address)).toEqual(["anna@x.com"]);

    const all = suggestContacts(db, a.id, "an", { includeOtherAccounts: true });
    expect(all.map(c => [c.address, c.other ?? false])).toEqual([
      ["anna@x.com", false], // this account's own first
      ["anton@x.com", true], // then the other account's — and anna isn't offered a second time
    ]);
  });

  test("other accounts are ranked like our own and their counts add up; the two lists are capped separately", async () => {
    const { db, a, b, make } = await twoAccounts();
    const c = make("c@example.com");
    createEmail(db, a.id, mailFrom("own1@x.com"));
    createEmail(db, a.id, mailFrom("own2@x.com"));
    createEmail(db, b.id, mailFrom("rare@x.com"));
    createEmail(db, b.id, mailFrom("common@x.com"));
    createEmail(db, c.id, mailFrom("common@x.com")); // seen in two other accounts
    createEmail(db, c.id, mailFrom("cc@x.com", "Cc Person"));

    const result = suggestContacts(db, a.id, "", { limit: 1, includeOtherAccounts: true, otherLimit: 2 });
    expect(result.map(r => [r.address, r.other ?? false])).toEqual([
      ["own1@x.com", false],
      ["common@x.com", true], // most frequent across the others
      ["cc@x.com", true], // then by recency among the equally rare ones
    ]);
    expect(result[1]!.fromCount).toBe(2);
  });

  test("other accounts of another user are never suggested", async () => {
    const { db, a } = await twoAccounts();
    const bob = await createUser(db, "bob", "pw");
    const bobs = createAccount(db, bob.id, accountInput("bob@example.com"), deriveEncryptionKey("pw", generateSalt()));
    createEmail(db, bobs.id, mailFrom("secret@x.com", "Secret"));
    expect(suggestContacts(db, a.id, "sec", { includeOtherAccounts: true })).toEqual([]);
  });

  test("the other-accounts search matches names the same forgiving way", async () => {
    const { db, a, b } = await twoAccounts();
    createEmail(db, b.id, mailFrom("flastname@example.com", "'First Lastname'"));
    expect(suggestContacts(db, a.id, "First", { includeOtherAccounts: true }).map(c => c.address)).toEqual(["flastname@example.com"]);
  });
});
