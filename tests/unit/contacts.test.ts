import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount } from "../../src/server/models/accounts";
import { createEmail, updateEmail } from "../../src/server/models/emails";
import { rebuildContactsIfEmpty, suggestContacts } from "../../src/server/models/contacts";

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
