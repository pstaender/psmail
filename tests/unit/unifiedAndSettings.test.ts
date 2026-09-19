import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount, deleteAccount, learnSpecialFolders, listAccounts, setAccountPosition, setSentFolder, updateAccount, normalizeAccountPositions } from "../../src/server/models/accounts";
import { addAttachment, createEmail, listEmails, updateEmail } from "../../src/server/models/emails";
import { countUnifiedInboxUnread, listNewInboxMail, listUnifiedEmails } from "../../src/server/models/unified";
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

describe("user settings: sync interval and combined-inbox folders", () => {
  test("accepts whole minutes (or null to clear) and a boolean, rejects anything else", async () => {
    const { db, user } = await setup([]);
    expect(updateUserSettings(db, user.id, { syncIntervalMinutes: 5, combinedInboxIncludesFolders: true })).toEqual({
      syncIntervalMinutes: 5,
      combinedInboxIncludesFolders: true,
    });
    expect(updateUserSettings(db, user.id, { syncIntervalMinutes: null })).toEqual({ combinedInboxIncludesFolders: true });

    for (const bad of [0, -1, 1.5, "5", 1441, NaN]) {
      expect(() => updateUserSettings(db, user.id, { syncIntervalMinutes: bad })).toThrow(/syncIntervalMinutes/);
    }
    expect(() => updateUserSettings(db, user.id, { combinedInboxIncludesFolders: "yes" })).toThrow(/true or false/);
  });
});

describe("combined Inbox including other folders", () => {
  test("adds incoming folders, but never Sent/Drafts/Trash/Junk/Archive (learned paths or common names)", async () => {
    const { db, user, accounts } = await setup(["a@x.com"]);
    const id = accounts[0]!.id;
    mail(db, id, "INBOX", "in inbox", "2026-01-01T00:00:00.000Z");
    mail(db, id, "Newsletters", "in newsletters", "2026-01-02T00:00:00.000Z");
    mail(db, id, "INBOX.Lists", "in lists", "2026-01-03T00:00:00.000Z");
    mail(db, id, "Sent", "sent", "2026-01-04T00:00:00.000Z");
    mail(db, id, "Entwürfe", "draft", "2026-01-05T00:00:00.000Z");
    mail(db, id, "Papierkorb", "trash", "2026-01-06T00:00:00.000Z");
    mail(db, id, "[Gmail]/Spam", "spam", "2026-01-07T00:00:00.000Z");
    mail(db, id, "Old Stuff", "learned as archive", "2026-01-08T00:00:00.000Z");
    learnSpecialFolders(db, id, [{ path: "Old Stuff", specialUse: "\\Archive" }]);

    const subjects = (includeFolders: boolean) => listUnifiedEmails(db, user.id, "inbox", { includeFolders }).map(r => r.subject);
    expect(subjects(false)).toEqual(["in inbox"]);
    expect(subjects(true)).toEqual(["in lists", "in newsletters", "in inbox"]);
    // The result says which folder each message is in.
    expect(listUnifiedEmails(db, user.id, "inbox", { includeFolders: true }).map(r => r.folder)).toEqual(["INBOX.Lists", "Newsletters", "INBOX"]);
  });

  test("the unread badge follows the same setting", async () => {
    const { db, user, accounts } = await setup(["a@x.com", "b@x.com"]);
    mail(db, accounts[0]!.id, "INBOX", "u1", "2026-01-01T00:00:00.000Z");
    mail(db, accounts[0]!.id, "Newsletters", "u2", "2026-01-02T00:00:00.000Z");
    mail(db, accounts[1]!.id, "Newsletters", "u3", "2026-01-03T00:00:00.000Z");
    mail(db, accounts[1]!.id, "Trash", "u4", "2026-01-04T00:00:00.000Z");

    expect(countUnifiedInboxUnread(db, user.id)).toBe(1);
    expect(countUnifiedInboxUnread(db, user.id, { includeFolders: true })).toBe(3);
  });

  test("paging works across the merged folders", async () => {
    const { db, user, accounts } = await setup(["a@x.com"]);
    mail(db, accounts[0]!.id, "INBOX", "1", "2026-01-01T00:00:00.000Z");
    mail(db, accounts[0]!.id, "Lists", "2", "2026-01-02T00:00:00.000Z");
    mail(db, accounts[0]!.id, "INBOX", "3", "2026-01-03T00:00:00.000Z");
    expect(listUnifiedEmails(db, user.id, "inbox", { includeFolders: true, limit: 2, offset: 1 }).map(r => r.subject)).toEqual(["2", "1"]);
  });
});

describe("listNewInboxMail", () => {
  const NOW = Date.parse("2026-03-10T12:00:00.000Z");
  const recent = "2026-03-10T11:00:00.000Z";

  test("without afterId it only reports where to start; nothing new since the latest id", async () => {
    const { db, user, accounts } = await setup(["a@x.com"]);
    mail(db, accounts[0]!.id, "INBOX", "old", recent);
    const start = listNewInboxMail(db, user.id, null, { now: NOW });
    expect(start).toEqual({ latestId: expect.any(Number), total: 0, messages: [] });
    expect(start.latestId).toBeGreaterThan(0);
    expect(listNewInboxMail(db, user.id, start.latestId, { now: NOW }).total).toBe(0);
  });

  test("returns mail after afterId with sender, subject, date, recipients and a text snippet", async () => {
    const { db, user, accounts } = await setup(["a@x.com"]);
    const { latestId } = listNewInboxMail(db, user.id, null, { now: NOW });
    mail(db, accounts[0]!.id, "INBOX", "Lunch?", recent, {
      from: [{ name: "Alice", address: "alice@x.com" }],
      to: [{ address: "a@x.com" }],
      cc: [{ address: "bob@x.com" }],
      plainText: "  Hi there,\n\n  are you free   for lunch?  ",
    });

    const result = listNewInboxMail(db, user.id, latestId, { now: NOW });
    expect(result.total).toBe(1);
    expect(result.messages[0]).toMatchObject({
      accountEmail: "a@x.com",
      folder: "INBOX",
      subject: "Lunch?",
      date: recent,
      from: [{ name: "Alice", address: "alice@x.com" }],
      cc: [{ address: "bob@x.com" }],
      snippet: "Hi there, are you free for lunch?",
    });
    // Asking again from the new latestId finds nothing: each message is announced once.
    expect(listNewInboxMail(db, user.id, result.latestId, { now: NOW }).total).toBe(0);
  });

  test("skips read mail, drafts, other users, other folders, sent mail and anything older than a day", async () => {
    const { db, user, accounts } = await setup(["a@x.com"]);
    const other = await createUser(db, "bob", "pw");
    const bobs = createAccount(db, other.id, accountInput("bob@x.com"), key);
    const { latestId } = listNewInboxMail(db, user.id, null, { now: NOW });

    mail(db, accounts[0]!.id, "INBOX", "counts", recent);
    mail(db, accounts[0]!.id, "INBOX", "already read", recent, { isRead: true });
    mail(db, accounts[0]!.id, "INBOX", "a draft", recent, { isDraft: true });
    mail(db, accounts[0]!.id, "INBOX", "first-sync backlog", "2026-03-01T00:00:00.000Z");
    mail(db, accounts[0]!.id, "Sent", "sent by me", recent);
    mail(db, accounts[0]!.id, "Newsletters", "other folder", recent);
    mail(db, bobs.id, "INBOX", "someone else's", recent);

    expect(listNewInboxMail(db, user.id, latestId, { now: NOW }).messages.map(m => m.subject)).toEqual(["counts"]);
    // With the combined-Inbox folder option, the other incoming folder counts too — but Sent still doesn't.
    expect(
      listNewInboxMail(db, user.id, latestId, { now: NOW, includeFolders: true }).messages.map(m => m.subject).sort()
    ).toEqual(["counts", "other folder"]);
  });

  test("total counts everything new while messages holds only the newest few; html-only mail gets a snippet too", async () => {
    const { db, user, accounts } = await setup(["a@x.com"]);
    const { latestId } = listNewInboxMail(db, user.id, null, { now: NOW });
    for (let i = 1; i <= 8; i++) mail(db, accounts[0]!.id, "INBOX", `mail ${i}`, recent);
    mail(db, accounts[0]!.id, "INBOX", "html only", recent, {
      plainText: null,
      htmlText: "<style>p{color:red}</style><p>Hello <b>world</b> &amp; friends</p>",
    });

    const result = listNewInboxMail(db, user.id, latestId, { now: NOW, limit: 3 });
    expect(result.total).toBe(9);
    expect(result.messages.map(m => m.subject)).toEqual(["html only", "mail 8", "mail 7"]);
    expect(result.messages[0]!.snippet).toBe("Hello world & friends");
  });
});

describe("user settings: notifications", () => {
  test("accepts the two opt-ins and a known sound, rejects anything else", async () => {
    const { db, user } = await setup([]);
    expect(updateUserSettings(db, user.id, { notifyBrowser: true, notifyToast: true, notificationSound: "marimba" })).toEqual({
      notifyBrowser: true,
      notifyToast: true,
      notificationSound: "marimba",
    });
    expect(updateUserSettings(db, user.id, { notificationSound: "none", notifyBrowser: null })).toEqual({
      notifyToast: true,
      notificationSound: "none",
    });
    expect(() => updateUserSettings(db, user.id, { notifyToast: "yes" })).toThrow(/true or false/);
    expect(() => updateUserSettings(db, user.id, { notificationSound: "airhorn" })).toThrow(/notificationSound/);
  });
});

describe("an Inbox that isn't spelled INBOX", () => {
  test("the combined Inbox, its unread count and new-mail detection find a folder named Inbox / inbox", async () => {
    const { db, user, accounts } = await setup(["a@x.com", "b@x.com"]);
    mail(db, accounts[0]!.id, "Inbox", "mixed case", "2026-01-02T00:00:00.000Z");
    mail(db, accounts[1]!.id, "INBOX", "upper case", "2026-01-01T00:00:00.000Z");
    mail(db, accounts[0]!.id, "Archive", "elsewhere", "2026-01-03T00:00:00.000Z");

    expect(listUnifiedEmails(db, user.id, "inbox").map(r => r.subject)).toEqual(["mixed case", "upper case"]);
    expect(countUnifiedInboxUnread(db, user.id)).toBe(2);

    const { latestId } = listNewInboxMail(db, user.id, null, { now: Date.parse("2026-01-04T00:00:00.000Z") });
    mail(db, accounts[0]!.id, "inbox", "lowercase arrives", new Date("2026-01-03T23:00:00.000Z").toISOString());
    expect(listNewInboxMail(db, user.id, latestId, { now: Date.parse("2026-01-04T00:00:00.000Z") }).messages.map(m => m.subject)).toEqual(["lowercase arrives"]);
  });
});
