import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount } from "../../src/server/models/accounts";
import { createEmail, listEmails } from "../../src/server/models/emails";
import { listUnifiedEmails } from "../../src/server/models/unified";
import { searchEmails } from "../../src/server/models/search";
import { dateBoundsSql, readDateBounds } from "../../src/server/models/dateBounds";
import { ApiError } from "../../src/server/types";

const key = deriveEncryptionKey("pw", generateSalt());
const input = (email: string) => ({
  email, imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: email, imapPassword: "x",
  smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: email, smtpPassword: "x",
});

async function setup() {
  const db = createTestDb();
  const user = await createUser(db, "alice", "pw");
  const a = createAccount(db, user.id, input("a@x.com"), key);
  const b = createAccount(db, user.id, input("b@x.com"), key);
  const mail = (accountId: number, subject: string, date: string | null, folder = "INBOX") =>
    createEmail(db, accountId, { folder, isDraft: false, subject, date, from: [{ address: "s@y.com" }] });
  return { db, user, a, b, mail };
}

const q = (s: string) => new URLSearchParams(s);

describe("readDateBounds", () => {
  test("normalizes to the stored format, in any zone", () => {
    expect(readDateBounds(q("after=2026-03-01T00:00:00Z&before=2026-03-02T01:00:00%2B01:00"))).toEqual({
      after: "2026-03-01T00:00:00.000Z",
      before: "2026-03-02T00:00:00.000Z",
    });
    expect(readDateBounds(q("before=2026-03-02"))).toEqual({ before: "2026-03-02T00:00:00.000Z" });
    expect(readDateBounds(q(""))).toEqual({});
    expect(readDateBounds(q("after="))).toEqual({});
  });

  test("something that isn't a date, or a window that is empty or backwards, is a 400", () => {
    for (const bad of ["after=yesterday", "before=2026-13-45", "after=2026-03-02&before=2026-03-01", "after=2026-03-02&before=2026-03-02"]) {
      expect(() => readDateBounds(q(bad))).toThrow(ApiError);
    }
  });

  test("the SQL is plain range comparisons, in the order after, before", () => {
    expect(dateBoundsSql({})).toEqual({ sql: "", params: [] });
    expect(dateBoundsSql({ after: "A", before: "B" }, "e.date")).toEqual({ sql: " AND e.date >= ? AND e.date < ?", params: ["A", "B"] });
    expect(dateBoundsSql({ before: "B" })).toEqual({ sql: " AND date < ?", params: ["B"] });
  });
});

describe("listEmails with a date window", () => {
  test("after is inclusive, before is exclusive; newest first; undated messages are outside every window", async () => {
    const { db, a, mail } = await setup();
    mail(a.id, "before", "2026-03-01T23:59:59.999Z");
    mail(a.id, "first ms", "2026-03-02T00:00:00.000Z");
    mail(a.id, "noon", "2026-03-02T12:00:00.000Z");
    mail(a.id, "last ms", "2026-03-02T23:59:59.999Z");
    mail(a.id, "next day", "2026-03-03T00:00:00.000Z");
    mail(a.id, "undated", null);

    const day = { after: "2026-03-02T00:00:00.000Z", before: "2026-03-03T00:00:00.000Z" };
    expect(listEmails(db, a.id, { folder: "INBOX", ...day }).map(e => e.subject)).toEqual(["last ms", "noon", "first ms"]);
    expect(listEmails(db, a.id, { folder: "INBOX", after: day.after }).map(e => e.subject)).toEqual(["next day", "last ms", "noon", "first ms"]);
    expect(listEmails(db, a.id, { folder: "INBOX", before: day.after }).map(e => e.subject)).toEqual(["before"]);
    expect(listEmails(db, a.id, { folder: "INBOX" })).toHaveLength(6); // no window: as before, undated included
  });

  test("paging works inside a window, and other folders and accounts stay out", async () => {
    const { db, a, b, mail } = await setup();
    for (let i = 1; i <= 5; i++) mail(a.id, `M${i}`, `2026-03-0${i}T10:00:00.000Z`);
    mail(a.id, "Archive one", "2026-03-03T10:00:00.000Z", "Archive");
    mail(b.id, "Other account", "2026-03-03T10:00:00.000Z");

    const window = { after: "2026-03-02T00:00:00.000Z", before: "2026-03-05T00:00:00.000Z" };
    expect(listEmails(db, a.id, { folder: "INBOX", ...window }).map(e => e.subject)).toEqual(["M4", "M3", "M2"]);
    expect(listEmails(db, a.id, { folder: "INBOX", ...window, limit: 2, offset: 2 }).map(e => e.subject)).toEqual(["M2"]);
  });
});

describe("listUnifiedEmails with a date window", () => {
  test("every account's list is cut to the window, then merged newest first", async () => {
    const { db, user, a, b, mail } = await setup();
    mail(a.id, "a-old", "2026-03-01T10:00:00.000Z");
    mail(b.id, "b-in", "2026-03-02T10:00:00.000Z");
    mail(a.id, "a-in", "2026-03-03T10:00:00.000Z");
    mail(b.id, "b-new", "2026-03-09T10:00:00.000Z");

    const window = { after: "2026-03-02T00:00:00.000Z", before: "2026-03-04T00:00:00.000Z" };
    expect(listUnifiedEmails(db, user.id, "inbox", window).map(r => r.subject)).toEqual(["a-in", "b-in"]);
    expect(listUnifiedEmails(db, user.id, "inbox", { before: window.after }).map(r => r.subject)).toEqual(["a-old"]);
    expect(listUnifiedEmails(db, user.id, "inbox", { after: window.before }).map(r => r.subject)).toEqual(["b-new"]);
    expect(listUnifiedEmails(db, user.id, "inbox", { ...window, limit: 1, offset: 1 }).map(r => r.subject)).toEqual(["b-in"]);
  });
});

describe("the queries stay on the index", () => {
  test("a window is a range scan of (account, folder, date, id): no full scan, no sort", async () => {
    const { db } = await setup();
    const plan = (sql: string, ...args: (string | number)[]) =>
      db.query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail).join(" | ");

    for (const window of [dateBoundsSql({ after: "A", before: "B" }), dateBoundsSql({ after: "A" }), dateBoundsSql({ before: "B" })]) {
      const detail = plan(
        `SELECT id FROM emails WHERE account_id = ? AND folder = ?${window.sql} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`,
        1, "INBOX", ...window.params, 50, 0
      );
      expect(detail).toContain("idx_emails_folder_date");
      expect(detail).toMatch(/date[<>]/); // the window is part of the index search
      expect(detail).not.toContain("SCAN emails");
      expect(detail).not.toContain("TEMP B-TREE");
    }
  });

  test("and it is fast on a big folder: a day out of 200 000 messages", async () => {
    const { db, a } = await setup();
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO emails (account_id, folder, uid, is_draft, subject, date) VALUES (?, 'INBOX', ?, 0, ?, ?)");
    const start = Date.UTC(2020, 0, 1);
    for (let i = 0; i < 200_000; i++) insert.run(a.id, i, `S${i}`, new Date(start + i * 60_000).toISOString()); // one a minute, ~139 days
    db.exec("COMMIT");

    const day = { after: new Date(start + 60 * 24 * 3_600_000).toISOString(), before: new Date(start + 61 * 24 * 3_600_000).toISOString() };
    const t = performance.now();
    const rows = listEmails(db, a.id, { folder: "INBOX", ...day, limit: 100 });
    const ms = performance.now() - t;
    expect(rows).toHaveLength(100);
    expect(rows[0]!.date! < day.before && rows.at(-1)!.date! >= day.after).toBe(true);
    expect(ms).toBeLessThan(200); // typically a few ms; the bound is loose on purpose
  });
});

describe("search within a date window", () => {
  test("the same query, but only over the messages in the window — by subject/sender and by text", async () => {
    const { db, user, a, b, mail } = await setup();
    mail(a.id, "Invoice old", "2011-09-01T10:00:00.000Z");
    mail(b.id, "Invoice mid", "2011-09-19T10:00:00.000Z");
    mail(a.id, "Invoice new", "2026-03-02T10:00:00.000Z");
    mail(a.id, "Other", "2011-09-10T10:00:00.000Z");

    const before = { before: "2011-09-20T00:00:00.000Z" };
    expect(searchEmails(db, user.id, "invoice").map(r => r.subject)).toEqual(["Invoice new", "Invoice mid", "Invoice old"]);
    expect(searchEmails(db, user.id, "invoice", before).map(r => r.subject)).toEqual(["Invoice mid", "Invoice old"]);
    expect(searchEmails(db, user.id, "invoice", { after: "2011-09-19T00:00:00.000Z", ...before }).map(r => r.subject)).toEqual(["Invoice mid"]);
    expect(searchEmails(db, user.id, "invoice", { after: "2027-01-01T00:00:00.000Z" })).toEqual([]);
    expect(searchEmails(db, user.id, "from:s@y.com other", before).map(r => r.subject)).toEqual(["Other"]); // from: and window together
  });

  test("the text fallback stays inside the window too", async () => {
    const { db, user, a } = await setup();
    const text = (subject: string, plainText: string, date: string) =>
      createEmail(db, a.id, { folder: "INBOX", isDraft: false, subject, plainText, date, from: [{ address: "s@y.com" }] });
    text("Old", "the needle is here", "2011-09-01T10:00:00.000Z");
    text("New", "the needle is here too", "2026-03-02T10:00:00.000Z");

    expect(searchEmails(db, user.id, "needle").map(r => r.subject)).toEqual(["New", "Old"]);
    const inWindow = searchEmails(db, user.id, "needle", { before: "2011-09-20T00:00:00.000Z" });
    expect(inWindow.map(r => r.subject)).toEqual(["Old"]);
    expect(inWindow[0]!.matchedInBody).toBe(true);
  });
});
