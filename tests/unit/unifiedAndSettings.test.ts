import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount, deleteAccount, listAccounts, setAccountPosition, setSentFolder, updateAccount, normalizeAccountPositions } from "../../src/server/models/accounts";
import { addAttachment, createEmail, listEmails, updateEmail } from "../../src/server/models/emails";
import { countUnifiedInboxUnread, listUnifiedEmails } from "../../src/server/models/unified";
import { searchEmails } from "../../src/server/models/search";
import { getUserSettings, updateUserSettings } from "../../src/server/models/userSettings";

const key = deriveEncryptionKey("pw", generateSalt());

function accountInput(email: string) {
  return {
    email,
    imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: email, imapPassword: "x",
    smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: email, smtpPassword: "x",
  };
}

async function setup(emails = ["a@x.com", "b@x.com", "c@x.com"]) {
  const db = createTestDb();
  const user = await createUser(db, "alice", "pw");
  const accounts = emails.map(email => createAccount(db, user.id, accountInput(email), key));
  return { db, user, accounts };
}

function mail(db: ReturnType<typeof createTestDb>, accountId: number, folder: string, subject: string, date: string, extra = {}) {
  return createEmail(db, accountId, { folder, isDraft: false, subject, date, from: [{ address: "s@y.com" }], ...extra });
}

describe("account position", () => {
  test("new accounts are appended, and moving one shifts the others (gap-free 1..n)", async () => {
    const { db, user, accounts } = await setup();
    expect(accounts.map(a => a.position)).toEqual([1, 2, 3]);

    setAccountPosition(db, accounts[2]!.id, 1);
    expect(listAccounts(db, user.id).map(a => [a.email, a.position])).toEqual([
      ["c@x.com", 1],
      ["a@x.com", 2],
      ["b@x.com", 3],
    ]);

    // clamped to the valid range
    setAccountPosition(db, accounts[2]!.id, 99);
    expect(listAccounts(db, user.id).map(a => a.email)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    setAccountPosition(db, accounts[2]!.id, -5);
    expect(listAccounts(db, user.id).map(a => a.email)).toEqual(["c@x.com", "a@x.com", "b@x.com"]);
  });

  test("updateAccount({position}) repositions, and deleting an account closes the gap", async () => {
    const { db, user, accounts } = await setup();
    updateAccount(db, accounts[0]!.id, { position: 2 }, key);
    expect(listAccounts(db, user.id).map(a => a.email)).toEqual(["b@x.com", "a@x.com", "c@x.com"]);

    deleteAccount(db, accounts[1]!.id);
    expect(listAccounts(db, user.id).map(a => [a.email, a.position])).toEqual([["a@x.com", 1], ["c@x.com", 2]]);
  });

  test("positions are per user, and normalizeAccountPositions repairs legacy all-zero rows", async () => {
    const { db, user, accounts } = await setup();
    const other = await createUser(db, "bob", "pw");
    const bobs = createAccount(db, other.id, accountInput("bob@x.com"), key);
    expect(bobs.position).toBe(1);

    db.exec("UPDATE accounts SET position = 0");
    normalizeAccountPositions(db);
    expect(listAccounts(db, user.id).map(a => [a.email, a.position])).toEqual([["a@x.com", 1], ["b@x.com", 2], ["c@x.com", 3]]);
    expect(accounts).toHaveLength(3);
  });
});

describe("listUnifiedEmails", () => {
  test("inbox: every account's INBOX merged newest-first, with paging", async () => {
    const { db, user, accounts } = await setup(["a@x.com", "b@x.com"]);
    mail(db, accounts[0]!.id, "INBOX", "a-old", "2026-01-01T00:00:00.000Z");
    mail(db, accounts[1]!.id, "INBOX", "b-mid", "2026-01-02T00:00:00.000Z");
    mail(db, accounts[0]!.id, "INBOX", "a-new", "2026-01-03T00:00:00.000Z");
    mail(db, accounts[0]!.id, "Archive", "not-inbox", "2026-01-04T00:00:00.000Z");

    const all = listUnifiedEmails(db, user.id, "inbox");
    expect(all.map(r => [r.subject, r.accountEmail])).toEqual([
      ["a-new", "a@x.com"],
      ["b-mid", "b@x.com"],
      ["a-old", "a@x.com"],
    ]);
    expect(listUnifiedEmails(db, user.id, "inbox", { limit: 1, offset: 1 }).map(r => r.subject)).toEqual(["b-mid"]);
    expect(listUnifiedEmails(db, user.id, "inbox", { limit: 5, offset: 3 })).toEqual([]);
  });

  test("sent: uses each account's learned Sent folder, else recognizes common names, else 'Sent'", async () => {
    const { db, user, accounts } = await setup(["a@x.com", "b@x.com", "c@x.com"]);
    mail(db, accounts[0]!.id, "Gesendete Elemente", "a-sent", "2026-01-01T00:00:00.000Z");
    setSentFolder(db, accounts[0]!.id, "Gesendete Elemente");
    mail(db, accounts[1]!.id, "Sent Items", "b-sent", "2026-01-02T00:00:00.000Z"); // recognized by name
    mail(db, accounts[2]!.id, "Sent", "c-sent", "2026-01-03T00:00:00.000Z"); // fallback
    mail(db, accounts[2]!.id, "INBOX", "c-inbox", "2026-01-04T00:00:00.000Z");

    expect(listUnifiedEmails(db, user.id, "sent").map(r => r.subject)).toEqual(["c-sent", "b-sent", "a-sent"]);
  });

  test("only includes the requesting user's accounts", async () => {
    const { db, user, accounts } = await setup(["a@x.com"]);
    const other = await createUser(db, "bob", "pw");
    const bobs = createAccount(db, other.id, accountInput("bob@x.com"), key);
    mail(db, accounts[0]!.id, "INBOX", "mine", "2026-01-01T00:00:00.000Z");
    mail(db, bobs.id, "INBOX", "theirs", "2026-01-02T00:00:00.000Z");
    expect(listUnifiedEmails(db, user.id, "inbox").map(r => r.subject)).toEqual(["mine"]);
  });
});

describe("search: leading `favs`", () => {
  test("lists only flagged messages, combined with any remaining terms", async () => {
    const { db, user, accounts } = await setup(["a@x.com"]);
    mail(db, accounts[0]!.id, "INBOX", "Amazon fav", "2026-01-01T00:00:00.000Z", { isFlagged: true });
    mail(db, accounts[0]!.id, "INBOX", "Amazon plain", "2026-01-02T00:00:00.000Z");
    mail(db, accounts[0]!.id, "INBOX", "Other fav", "2026-01-03T00:00:00.000Z", { isFlagged: true });

    expect(searchEmails(db, user.id, "favs").map(r => r.subject)).toEqual(["Other fav", "Amazon fav"]);
    expect(searchEmails(db, user.id, "favs amazon").map(r => r.subject)).toEqual(["Amazon fav"]);
    expect(searchEmails(db, user.id, "amazon").map(r => r.subject)).toEqual(["Amazon plain", "Amazon fav"]);
  });
});

describe("user settings", () => {
  test("defaults to empty, merges patches, removes a key on null, and is per user", async () => {
    const { db, user } = await setup([]);
    const other = await createUser(db, "bob", "pw");
    expect(getUserSettings(db, user.id)).toEqual({});

    expect(updateUserSettings(db, user.id, { bodyView: "md" })).toEqual({ bodyView: "md" });
    expect(getUserSettings(db, user.id)).toEqual({ bodyView: "md" });
    expect(getUserSettings(db, other.id)).toEqual({});

    expect(updateUserSettings(db, user.id, { bodyView: null })).toEqual({});
  });

  test("rejects unknown keys and invalid values", async () => {
    const { db, user } = await setup([]);
    expect(() => updateUserSettings(db, user.id, { bodyView: "nope" })).toThrow(/bodyView/);
    expect(() => updateUserSettings(db, user.id, { theme: "dark" })).toThrow(/Unknown setting/);
  });
});

function attach(db: ReturnType<typeof createTestDb>, emailId: number, isInline: boolean) {
  addAttachment(db, emailId, { filename: "f.pdf", contentType: "application/pdf", contentId: null, isInline, size: 1, filePath: "/tmp/f.pdf" });
}

describe("attachment indicator", () => {
  test("list rows carry the number of real attachments; inline images don't count", async () => {
    const { db, accounts } = await setup(["a@x.com"]);
    const withFile = mail(db, accounts[0]!.id, "INBOX", "has file", "2026-01-03T00:00:00.000Z");
    const onlyInline = mail(db, accounts[0]!.id, "INBOX", "logo only", "2026-01-02T00:00:00.000Z");
    mail(db, accounts[0]!.id, "INBOX", "none", "2026-01-01T00:00:00.000Z");
    attach(db, withFile.id, false);
    attach(db, withFile.id, false);
    attach(db, onlyInline.id, true);

    expect(listEmails(db, accounts[0]!.id, { folder: "INBOX" }).map(e => [e.subject, e.attachmentCount])).toEqual([
      ["has file", 2],
      ["logo only", 0],
      ["none", 0],
    ]);
  });

  test("unified lists and search results flag messages with attachments", async () => {
    const { db, user, accounts } = await setup(["a@x.com"]);
    const withFile = mail(db, accounts[0]!.id, "INBOX", "has file", "2026-01-02T00:00:00.000Z");
    mail(db, accounts[0]!.id, "INBOX", "none", "2026-01-01T00:00:00.000Z");
    attach(db, withFile.id, false);

    expect(listUnifiedEmails(db, user.id, "inbox").map(r => [r.subject, r.hasAttachments])).toEqual([["has file", true], ["none", false]]);
    expect(searchEmails(db, user.id, "file").map(r => [r.subject, r.hasAttachments])).toEqual([["has file", true]]);
  });
});

describe("countUnifiedInboxUnread", () => {
  test("counts unread INBOX messages across the user's accounts only", async () => {
    const { db, user, accounts } = await setup(["a@x.com", "b@x.com"]);
    const other = await createUser(db, "bob", "pw");
    const bobs = createAccount(db, other.id, accountInput("bob@x.com"), key);

    const first = mail(db, accounts[0]!.id, "INBOX", "u1", "2026-01-01T00:00:00.000Z");
    mail(db, accounts[1]!.id, "INBOX", "u2", "2026-01-02T00:00:00.000Z");
    mail(db, accounts[1]!.id, "INBOX", "read", "2026-01-03T00:00:00.000Z", { isRead: true });
    mail(db, accounts[0]!.id, "Archive", "elsewhere", "2026-01-04T00:00:00.000Z");
    mail(db, bobs.id, "INBOX", "not mine", "2026-01-05T00:00:00.000Z");

    expect(countUnifiedInboxUnread(db, user.id)).toBe(2);
    updateEmail(db, first.id, { isRead: true });
    expect(countUnifiedInboxUnread(db, user.id)).toBe(1);
  });
});
