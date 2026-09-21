import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount, learnSpecialFolders } from "../../src/server/models/accounts";
import { createEmail, getEmail } from "../../src/server/models/emails";
import { addAttachment } from "../../src/server/models/emails";
import { classifyAccounts, classifyAndStore, createImboxContext, explainEmail, isImboxFolder, isJunkFolder, isTrashFolder, setImbox, setImboxByHand, subjectShape } from "../../src/server/models/imbox";
import { countUnifiedInboxUnread, listUnifiedEmails } from "../../src/server/models/unified";
import { getUserSettings, updateUserSettings } from "../../src/server/models/userSettings";
import { runMigrations } from "../../src/server/db/migrations";
import { ApiError } from "../../src/server/types";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const key = deriveEncryptionKey("pw", generateSalt());
const input = (email: string, extra = {}) => ({
  email, displayName: "Philipp Staender", imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: email, imapPassword: "x",
  smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: email, smtpPassword: "x", ...extra,
});

async function setup() {
  const db = createTestDb();
  const user = await createUser(db, "philipp", "pw");
  const account = createAccount(db, user.id, input("philipp@example.com"), key);
  const other = createAccount(db, user.id, input("philipp@work.example.org"), key);
  let uid = 0;
  const mail = (accountId: number, over: Record<string, unknown>) =>
    createEmail(db, accountId, {
      folder: "INBOX", uid: ++uid, isDraft: false, date: "2026-05-01T10:00:00.000Z",
      to: [{ address: "philipp@example.com" }], subject: "", plainText: "", ...over,
    });
  return { db, user, account, other, mail };
}

const ME = { name: "Philipp Staender", address: "philipp@example.com" };
const PERSON = (address: string, name = "Anna Becker") => [{ name, address }];

describe("folder kinds", () => {
  test("junk folders by learned path or by name; imbox folders are incoming ones", () => {
    const account = { id: 1, email: "a@b.c", display_name: null, sender_name: null, sent_folder: "Gesendet", special_folders: JSON.stringify({ junk: "Unerwuenscht/Weg", trash: "Papierkorb" }) };
    expect(isJunkFolder("Unerwuenscht/Weg", account)).toBe(true);
    expect(isJunkFolder("Junk E-Mail", account)).toBe(true);
    expect(isJunkFolder("[Gmail]/Spam", account)).toBe(true);
    expect(isJunkFolder("INBOX", account)).toBe(false);
    expect(isImboxFolder("INBOX", account)).toBe(true);
    expect(isImboxFolder("Projekte/Alpha", account)).toBe(true);
    for (const folder of ["Gesendet", "Papierkorb", "Drafts", "Unerwuenscht/Weg", "Junk", "Archive"]) expect(isImboxFolder(folder, account)).toBe(false);
  });
});

describe("what the mailbox tells the classifier", () => {
  test("someone I have written to is important; a stranger who writes the same isn't (without a greeting)", async () => {
    const { db, user, account, mail } = await setup();
    mail(account.id, { folder: "Sent", from: [ME], to: PERSON("anna@friend.example"), subject: "Hi", plainText: "Wie geht's?" });
    const known = mail(account.id, { from: PERSON("anna@friend.example"), subject: "Kaffee?", plainText: "Lust auf einen Kaffee heute?" });
    const stranger = mail(account.id, { from: PERSON("x@nobody.example", "X"), subject: "Kaffee?", plainText: "Lust auf einen Kaffee heute?" });

    const context = createImboxContext(db, user.id);
    const reasons = (id: number) => context.classifyRow(explainRow(db, id)).reasons.map(r => r.signal);
    expect(reasons(known.id)).toContain("you have written to this address");
    expect(reasons(stranger.id)).not.toContain("you have written to this address");
    expect(classifyAndStore(db, context, known.id)?.important).toBe(true);
    expect(classifyAndStore(db, context, stranger.id)?.important).toBe(false);
    expect(getEmail(db, known.id).imbox).toBe(true);
    expect(getEmail(db, stranger.id).imbox).toBe(false);
  });

  test("sent mail from another of my accounts counts: I wrote to them from the work address", async () => {
    const { db, user, other, account, mail } = await setup();
    mail(other.id, { folder: "Sent", from: [{ address: "philipp@work.example.org" }], to: PERSON("chef@firma.example"), subject: "Bericht", plainText: "Anbei." });
    const reply = mail(account.id, { from: PERSON("chef@firma.example", "Chef"), subject: "Danke", plainText: "Hallo Philipp, danke für den Bericht." });
    expect(explainEmail(db, user.id, reply.id).reasons.map(r => r.signal)).toContain("you have written to this address");
  });

  test("earlier normal mail from an address helps, earlier Junk from it hurts, and the message itself is never counted as 'earlier'", async () => {
    const { db, user, account, mail } = await setup();
    learnSpecialFolders(db, account.id, [{ path: "INBOX", specialUse: "\\Inbox" }, { path: "Spam", specialUse: "\\Junk" }]);

    const lone = mail(account.id, { from: PERSON("solo@x.example", "Solo"), subject: "Frage", plainText: "Hallo Philipp, kurze Frage." });
    expect(explainEmail(db, user.id, lone.id).reasons.some(r => r.signal.startsWith("you have received normal mail"))).toBe(false); // itself isn't earlier

    mail(account.id, { from: PERSON("solo@x.example", "Solo"), subject: "Davor", plainText: "Hi Philipp." });
    expect(explainEmail(db, user.id, lone.id).reasons.some(r => r.signal.startsWith("you have received normal mail"))).toBe(true);

    for (let i = 0; i < 3; i++) mail(account.id, { folder: "Spam", from: PERSON("bad@spam.example", "Bad"), subject: `Spam ${i}`, plainText: "Buy now" });
    const later = mail(account.id, { from: PERSON("bad@spam.example", "Bad"), subject: "Hello", plainText: "Hi Philipp, look." });
    const verdict = explainEmail(db, user.id, later.id);
    expect(verdict.reasons.find(r => r.signal.startsWith("earlier messages from this address were spam"))?.detail).toBe("3 in Junk");
    expect(verdict.important).toBe(false);
  });

  test("a message in the Junk folder is never important", async () => {
    const { db, user, account, mail } = await setup();
    learnSpecialFolders(db, account.id, [{ path: "Spam", specialUse: "\\Junk" }]);
    mail(account.id, { folder: "Sent", from: [ME], to: PERSON("anna@friend.example"), subject: "Hi", plainText: "x" });
    const inJunk = mail(account.id, { folder: "Spam", from: PERSON("anna@friend.example"), subject: "Hi", plainText: "Hallo Philipp!" });
    const verdict = explainEmail(db, user.id, inJunk.id);
    expect(verdict.important).toBe(false);
    expect(verdict.ruledOut).toBe("in the Junk folder");
  });

  test("an answer to a message I sent is recognised by In-Reply-To or References", async () => {
    const { db, user, account, mail } = await setup();
    mail(account.id, { folder: "Sent", from: [ME], to: PERSON("stranger@firma.example"), subject: "Anfrage", plainText: "Bitte um Angebot.", messageId: "<sent-1@example.com>" });
    const byInReplyTo = mail(account.id, { from: PERSON("stranger@firma.example", "S"), subject: "Re: Anfrage", plainText: "Gerne.", inReplyTo: "<sent-1@example.com>" });
    const byReferences = mail(account.id, { from: PERSON("stranger@firma.example", "S"), subject: "Re: Anfrage", plainText: "Nochmal.", headersRaw: "References: <a@x> <b@x>\n <sent-1@example.com>\nSubject: Re: Anfrage" });
    const unrelated = mail(account.id, { from: PERSON("stranger@firma.example", "S"), subject: "Etwas", plainText: "Neu.", inReplyTo: "<somebody-elses@x.example>" });

    const answers = (id: number) => explainEmail(db, user.id, id).reasons.some(r => r.signal === "answers a message you sent");
    expect(answers(byInReplyTo.id)).toBe(true);
    expect(answers(byReferences.id)).toBe(true);
    expect(answers(unrelated.id)).toBe(false);
  });

  test("attachments are seen (a risky file from a stranger), inline ones aren't", async () => {
    const { db, user, account, mail } = await setup();
    const risky = mail(account.id, { from: PERSON("x@nobody.example", "X"), subject: "Rechnung", plainText: "Siehe Anhang." });
    addAttachment(db, risky.id, { filename: "rechnung.exe", size: 10, filePath: "/tmp/x" });
    addAttachment(db, risky.id, { filename: "logo.png", isInline: true, size: 10, filePath: "/tmp/y" });
    const reasons = explainEmail(db, user.id, risky.id).reasons;
    expect(reasons.find(r => r.signal.startsWith("risky attachment"))?.detail).toBe("rechnung.exe");
  });

  test("names come from the accounts: 'Hallo Philipp' and the address's own words", async () => {
    const { db, user, account, mail } = await setup();
    const named = mail(account.id, { from: PERSON("x@nobody.example", "X"), subject: "Frage", plainText: "Hallo Staender,\n\nkurze Frage." });
    expect(explainEmail(db, user.id, named.id).reasons.some(r => r.signal === "greets you by name")).toBe(true);
  });
});

/** The row the classifier reads, for calling the context directly. */
function explainRow(db: ReturnType<typeof createTestDb>, id: number) {
  return (require("../../src/server/models/imbox") as typeof import("../../src/server/models/imbox")).getMessageRow(db, id);
}

describe("classifying stored mail in bulk", () => {
  async function mailbox() {
    const s = await setup();
    s.mail(s.account.id, { folder: "Sent", from: [ME], to: PERSON("anna@friend.example"), subject: "Hi", plainText: "x" });
    const friend = s.mail(s.account.id, { from: PERSON("anna@friend.example"), subject: "Samstag?", plainText: "Hey Philipp, Zeit am Samstag?" });
    const news = s.mail(s.account.id, {
      from: [{ name: "Shop", address: "newsletter@shop.example" }], subject: "40% Rabatt", plainText: "Nur heute! Newsletter abbestellen",
      headersRaw: "List-Unsubscribe: <mailto:u@shop.example>",
    });
    const draft = createEmail(s.db, s.account.id, { folder: "Drafts", isDraft: true, subject: "d" });
    const otherAccountMail = s.mail(s.other.id, { to: [{ address: "philipp@work.example.org" }], from: PERSON("julia@work.example.org", "Julia"), subject: "Meeting morgen", plainText: "Hi Philipp, Besprechung morgen?" });
    return { ...s, friend, news, draft, otherAccountMail };
  }

  test("every account by default: verdicts for incoming mail, nothing for Sent, Drafts or already-classified mail", async () => {
    const { db, user, friend, news, draft, otherAccountMail } = await mailbox();
    const result = classifyAccounts(db, user.id);

    expect(result).toEqual({ examined: 3, important: 2, notImportant: 1 });
    expect(getEmail(db, friend.id).imbox).toBe(true);
    expect(getEmail(db, news.id).imbox).toBe(false);
    expect(getEmail(db, otherAccountMail.id).imbox).toBe(true);
    expect(getEmail(db, draft.id).imbox).toBeNull();
    const sent = db.query<{ imbox: number | null }, []>("SELECT imbox FROM emails WHERE folder = 'Sent'").get()!;
    expect(sent.imbox).toBeNull();

    expect(classifyAccounts(db, user.id)).toEqual({ examined: 0, important: 0, notImportant: 0 }); // nothing left without a verdict
  });

  test("only the accounts asked for; force redoes verdicts, and a verdict set by hand is kept unless forced", async () => {
    const { db, user, account, friend, news, otherAccountMail } = await mailbox();
    expect(classifyAccounts(db, user.id, { accountIds: [account.id] }).examined).toBe(2);
    expect(getEmail(db, otherAccountMail.id).imbox).toBeNull(); // the other account wasn't asked for

    setImbox(db, news.id, true); // "this newsletter is important to me"
    expect(classifyAccounts(db, user.id, { accountIds: [account.id] }).examined).toBe(0);
    expect(getEmail(db, news.id).imbox).toBe(true);
    expect(classifyAccounts(db, user.id, { accountIds: [account.id], force: true }).examined).toBe(2);
    expect(getEmail(db, news.id).imbox).toBe(false); // classified again
    expect(getEmail(db, friend.id).imbox).toBe(true);
  });

  test("large mailboxes are done in chunks, all of them, and fast", async () => {
    const { db, user, account } = await setup();
    db.exec("BEGIN");
    const insert = db.prepare(
      "INSERT INTO emails (account_id, folder, uid, is_draft, subject, from_addr, to_addr, date, plain_text) VALUES (?, 'INBOX', ?, 0, ?, ?, ?, ?, ?)"
    );
    for (let i = 0; i < 3000; i++) {
      insert.run(account.id, i, `Subject ${i}`, JSON.stringify([{ name: "P", address: `p${i % 50}@x.example` }]), JSON.stringify([ME]), "2026-01-01T00:00:00.000Z", "Hallo Philipp, wie geht es dir? ".repeat(20));
    }
    db.exec("COMMIT");
    const t = performance.now();
    const result = classifyAccounts(db, user.id);
    expect(result.examined).toBe(3000);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM emails WHERE imbox IS NULL").get()!.n).toBe(0);
  });
});

describe("the imbox list", () => {
  test("kind imbox lists only messages classified as important, newest first, across accounts — with dates and categories still working", async () => {
    const { db, user, account, other, mail } = await setup();
    const a = mail(account.id, { from: PERSON("a@x.example"), subject: "A", date: "2026-03-01T00:00:00.000Z" });
    const b = mail(other.id, { from: PERSON("b@x.example"), subject: "B", date: "2026-03-03T00:00:00.000Z" });
    const c = mail(account.id, { from: PERSON("c@x.example"), subject: "C", date: "2026-03-02T00:00:00.000Z" });
    mail(account.id, { from: PERSON("d@x.example"), subject: "unclassified", date: "2026-03-04T00:00:00.000Z" });
    for (const id of [a.id, b.id]) setImbox(db, id, true);
    setImbox(db, c.id, false);

    expect(listUnifiedEmails(db, user.id, "imbox").map(r => r.subject)).toEqual(["B", "A"]);
    expect(listUnifiedEmails(db, user.id, "inbox").map(r => r.subject)).toEqual(["unclassified", "B", "C", "A"]); // the Inbox still has everything
    expect(listUnifiedEmails(db, user.id, "imbox", { before: "2026-03-02T00:00:00.000Z" }).map(r => r.subject)).toEqual(["A"]);
  });

  test("it is a range scan of the partial index: no full scan, no sort", async () => {
    const { db } = await setup();
    const detail = db
      .query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT id FROM emails INDEXED BY idx_emails_imbox WHERE account_id = 1 AND folder = 'INBOX' AND imbox = 1 ORDER BY date DESC, id DESC LIMIT 50")
      .all()
      .map(r => r.detail)
      .join(" | ");
    expect(detail).toContain("idx_emails_imbox");
    expect(detail).not.toContain("TEMP B-TREE");
  });
});

describe("the imbox list stays fast", () => {
  test("100 000 messages, 200 of them important: the first page comes off the partial index in milliseconds", async () => {
    const { db, user, account } = await setup();
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO emails (account_id, folder, uid, is_draft, subject, date, imbox) VALUES (?, 'INBOX', ?, 0, ?, ?, ?)");
    const start = Date.UTC(2020, 0, 1);
    for (let i = 0; i < 100_000; i++) insert.run(account.id, i, `S${i}`, new Date(start + i * 60_000).toISOString(), i % 500 === 0 ? 1 : 0);
    db.exec("COMMIT");

    const t = performance.now();
    const page = listUnifiedEmails(db, user.id, "imbox", { limit: 50 });
    expect(page).toHaveLength(50);
    expect(performance.now() - t).toBeLessThan(100);
    expect(listUnifiedEmails(db, user.id, "imbox", { limit: 500 })).toHaveLength(200);
  });
});

describe("the setting and the migration", () => {
  test("imboxEnabled is a boolean user setting", async () => {
    const { db, user } = await setup();
    expect(getUserSettings(db, user.id).imboxEnabled).toBeUndefined();
    expect(updateUserSettings(db, user.id, { imboxEnabled: true }).imboxEnabled).toBe(true);
    expect(updateUserSettings(db, user.id, { imboxEnabled: null }).imboxEnabled).toBeUndefined();
    expect(() => updateUserSettings(db, user.id, { imboxEnabled: "yes" })).toThrow(ApiError);
  });

  test("running the migrations again is harmless (the column and index exist)", async () => {
    const { db } = await setup();
    expect(() => runMigrations(db)).not.toThrow();
  });
});


const signalsOf = (db: ReturnType<typeof createTestDb>, userId: number, emailId: number) => explainEmail(db, userId, emailId).reasons.map(r => r.signal);
const feedbackOf = (db: ReturnType<typeof createTestDb>, address: string) =>
  db.query<{ important: number; not_important: number; last_verdict: number | null }, [string]>("SELECT important, not_important, last_verdict FROM imbox_feedback WHERE address = ?").get(address);

describe("marking by hand: the strongest signal, learned per sender", () => {
  async function newsletterBox() {
    const s = await setup();
    const news = (subject: string, over = {}) =>
      s.mail(s.account.id, {
        from: [{ name: "Shop", address: "newsletter@shop.example" }], subject, plainText: "Nur heute 40% Rabatt! Newsletter abbestellen.",
        headersRaw: "List-Unsubscribe: <mailto:u@shop.example>", ...over,
      });
    return { ...s, news };
  }

  test("marking a message stores the verdict as manual and counts as one vote for its sender", async () => {
    const { db, user, news } = await newsletterBox();
    const first = news("Angebot 1");
    expect(explainEmail(db, user.id, first.id).important).toBe(false);

    setImboxByHand(db, user.id, first.id, true);
    expect(getEmail(db, first.id).imbox).toBe(true);
    expect(db.query<{ imbox_manual: number }, [number]>("SELECT imbox_manual FROM emails WHERE id = ?").get(first.id)!.imbox_manual).toBe(1);
    expect(feedbackOf(db, "newsletter@shop.example")).toEqual({ important: 1, not_important: 0, last_verdict: 1 });
  });

  test("mail that arrives later from that sender follows the mark — in the imbox, in the explanation, and after syncing", async () => {
    const { db, user, news } = await newsletterBox();
    setImboxByHand(db, user.id, news("Erste").id, true);

    const later = news("Zweite");
    const verdict = explainEmail(db, user.id, later.id);
    expect(verdict.important).toBe(true);
    expect(verdict.decidedBy).toBe("your mark on this sender");
    expect(verdict.reasons.some(r => r.signal.includes("marked mail from this address as important"))).toBe(true);
    expect(classifyAndStore(db, createImboxContext(db, user.id), later.id)?.important).toBe(true);
    expect(getEmail(db, later.id).imbox).toBe(true);
  });

  test("the other way: marking a friend's mail as not important makes the next one not important", async () => {
    const { db, user, account, mail } = await setup();
    mail(account.id, { folder: "Sent", from: [ME], to: PERSON("anna@friend.example"), subject: "Hi", plainText: "x" });
    const first = mail(account.id, { from: PERSON("anna@friend.example"), subject: "Kettenbrief", plainText: "Hey Philipp, leite das weiter!" });
    expect(explainEmail(db, user.id, first.id).important).toBe(true);
    setImboxByHand(db, user.id, first.id, false);

    const next = mail(account.id, { from: PERSON("anna@friend.example"), subject: "Noch einer", plainText: "Hey Philipp, hier noch einer." });
    expect(explainEmail(db, user.id, next.id).important).toBe(false);
  });

  test("a message carries one vote: marking it the other way replaces it, marking it again doesn't count twice, and taking it back removes it", async () => {
    const { db, user, news } = await newsletterBox();
    const message = news("Eine");
    setImboxByHand(db, user.id, message.id, true);
    setImboxByHand(db, user.id, message.id, true);
    expect(feedbackOf(db, "newsletter@shop.example")).toEqual({ important: 1, not_important: 0, last_verdict: 1 });

    setImboxByHand(db, user.id, message.id, false);
    expect(feedbackOf(db, "newsletter@shop.example")).toEqual({ important: 0, not_important: 1, last_verdict: 0 });

    setImboxByHand(db, user.id, message.id, null);
    expect(feedbackOf(db, "newsletter@shop.example")).toBeNull(); // nobody has an opinion on this sender any more
    const row = db.query<{ imbox: number | null; imbox_manual: number }, [number]>("SELECT imbox, imbox_manual FROM emails WHERE id = ?").get(message.id)!;
    expect(row).toEqual({ imbox: null, imbox_manual: 0 });
  });

  test("several messages, several votes: the latest opinion counts, and taking the latest back falls back to the one before", async () => {
    const { db, user, news } = await newsletterBox();
    const [a, b] = [news("A"), news("B")];
    setImboxByHand(db, user.id, a.id, true);
    setImboxByHand(db, user.id, b.id, false);
    expect(feedbackOf(db, "newsletter@shop.example")).toEqual({ important: 1, not_important: 1, last_verdict: 0 });
    setImboxByHand(db, user.id, b.id, null);
    expect(feedbackOf(db, "newsletter@shop.example")).toEqual({ important: 1, not_important: 0, last_verdict: 1 });
  });

  test("classifying (even --force) never overwrites a verdict set by hand", async () => {
    const { db, user, news } = await newsletterBox();
    const message = news("Wichtig fuer mich");
    setImboxByHand(db, user.id, message.id, true);
    expect(classifyAccounts(db, user.id, { force: true }).examined).toBe(0);
    expect(getEmail(db, message.id).imbox).toBe(true);
    setImboxByHand(db, user.id, message.id, null); // taken back: it is the classifier's again
    expect(classifyAccounts(db, user.id).examined).toBe(1);
  });

  test("only that sender is affected, and each user has their own opinions", async () => {
    const { db, user, account, news, mail } = await newsletterBox();
    setImboxByHand(db, user.id, news("Eins").id, true);
    const other = mail(account.id, { from: [{ name: "Other Shop", address: "newsletter@other-shop.example" }], subject: "Rabatt", plainText: "Nur heute 40% Rabatt! Abbestellen.", headersRaw: "List-Unsubscribe: <x>" });
    expect(explainEmail(db, user.id, other.id).important).toBe(false);

    const bob = await createUser(db, "bob", "pw");
    expect(createImboxContext(db, bob.id).classifyRow(explainRow(db, other.id)).decidedBy).toBeUndefined();
    expect(() => setImboxByHand(db, user.id, 9999, true)).toThrow();
  });
});

describe("what the user did with a sender's earlier mail, and what the sender's mail looks like", () => {
  test("starred and read earlier mail count for the sender; the message being classified is not its own history", async () => {
    const { db, user, account, mail } = await setup();
    const from = PERSON("kim@lee.example", "Kim Lee");
    for (let i = 0; i < 4; i++) mail(account.id, { from, subject: `Frage ${i}`, plainText: "Hi Philipp, kurze Frage.", isRead: true, isFlagged: i === 0 });
    const newest = mail(account.id, { from, subject: "Noch eine", plainText: "Hi Philipp, noch eine." });

    const signals = signalsOf(db, user.id, newest.id);
    expect(signals).toContain("you starred earlier mail from this address");
    expect(signals).toContain("you usually read mail from this address");
    const detail = explainEmail(db, user.id, newest.id).reasons.find(r => r.signal.startsWith("you usually read"))!.detail;
    expect(detail).toBe("4 of 4 read"); // the unread message itself isn't in the 4
  });

  test("mail from an address that was mostly moved to Trash counts against it", async () => {
    const { db, user, account, mail } = await setup();
    learnSpecialFolders(db, account.id, [{ path: "Trash", specialUse: "\\Trash" }]);
    const from = PERSON("pest@ads.example", "Pest");
    for (let i = 0; i < 3; i++) mail(account.id, { folder: "Trash", from, subject: `Anzeige ${i}`, plainText: "Hi Philipp, kaufen!" });
    const newest = mail(account.id, { from, subject: "Anzeige neu", plainText: "Hi Philipp, kaufen!" });
    expect(explainEmail(db, user.id, newest.id).reasons.find(r => r.signal.startsWith("you deleted"))?.detail).toBe("3 in Trash");
    expect(isTrashFolder("Trash", { special_folders: null })).toBe(true);
    expect(isTrashFolder("Papierkorb", { special_folders: null })).toBe(true);
    expect(isTrashFolder("INBOX", { special_folders: null })).toBe(false);
  });

  test("subject shapes: numbers, quoted parts and codes are ignored, so machine-made subjects match", () => {
    expect(subjectShape("Your order 4711 has shipped")).toBe(subjectShape("Your order 4712 has shipped"));
    expect(subjectShape("Re: Rechnung 2026-05")).toBe(subjectShape("Rechnung 2026-06"));
    expect(subjectShape('"Anna" commented on your post')).toBe(subjectShape('"Ben" commented on your post'));
    expect(subjectShape("Ticket [ABC-123] updated")).toBe(subjectShape("Ticket [XYZ-9] updated"));
    expect(subjectShape("Lunch tomorrow?")).not.toBe(subjectShape("Invoice for May"));
    expect(subjectShape(null)).toBe("");
  });

  test("a sender whose mails all have the same shape looks like a machine", async () => {
    const { db, user, account, mail } = await setup();
    const from = PERSON("robot@service.example", "Service");
    for (let i = 1; i <= 6; i++) mail(account.id, { from, subject: `Ihr Kontoauszug Nr. ${i}`, plainText: "Hi Philipp, Ihr Kontoauszug." });
    const newest = mail(account.id, { from, subject: "Ihr Kontoauszug Nr. 7", plainText: "Hi Philipp, Ihr Kontoauszug." });
    expect(explainEmail(db, user.id, newest.id).reasons.some(r => r.signal.startsWith("this sender's mails all look alike"))).toBe(true);

    const varied = PERSON("kim@lee.example", "Kim");
    for (const subject of ["Mittagessen", "Rechnung", "Urlaub", "Frage zum Code", "Danke"]) mail(account.id, { from: varied, subject, plainText: "Hi Philipp." });
    const last = mail(account.id, { from: varied, subject: "Noch was", plainText: "Hi Philipp." });
    expect(signalsOf(db, user.id, last.id)).not.toContain("this sender's mails all look alike");
  });

  test("your own organisation: mail from another address at a domain of one of your accounts (not a free-mail domain)", async () => {
    const db = createTestDb();
    const user = await createUser(db, "philipp", "pw");
    const work = createAccount(db, user.id, input("philipp@firma.example"), key);
    const private_ = createAccount(db, user.id, input("philipp@gmail.com"), key);
    const colleague = createEmail(db, work.id, { folder: "INBOX", isDraft: false, from: PERSON("julia@firma.example", "Julia"), to: [{ address: "philipp@firma.example" }], subject: "Frage", plainText: "Hi Philipp, kurze Frage." });
    const other = createEmail(db, private_.id, { folder: "INBOX", isDraft: false, from: PERSON("dave@gmail.com", "Dave"), to: [{ address: "philipp@gmail.com" }], subject: "Frage", plainText: "Hi Philipp, kurze Frage." });
    expect(signalsOf(db, user.id, colleague.id)).toContain("from your own organisation");
    expect(signalsOf(db, user.id, other.id)).not.toContain("from your own organisation");
  });
});

describe("calendar invitations", () => {
  let dir = "";
  const icsFile = (name: string, method: string) => {
    dir ||= mkdtempSync(join(tmpdir(), "psmail-ics-"));
    const path = join(dir, name);
    writeFileSync(path, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Sync\r\nDTSTART:20260930T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
    return path;
  };

  test("an invitation (METHOD:REQUEST) from a person is important; the method is read from the .ics file", async () => {
    const { db, user, account, mail } = await setup();
    const invite = mail(account.id, { from: PERSON("anna@becker.example", "Anna Becker"), subject: "Einladung: Sync", plainText: "Anna lädt dich ein." });
    addAttachment(db, invite.id, { filename: "invite.ics", contentType: "text/calendar", isInline: true, size: 200, filePath: icsFile("invite.ics", "REQUEST") });
    const verdict = explainEmail(db, user.id, invite.id);
    expect(verdict.reasons.find(r => r.signal === "a calendar invitation")?.detail).toBe("REQUEST");
    expect(verdict.important).toBe(true);

    const cancel = mail(account.id, { from: PERSON("anna@becker.example", "Anna Becker"), subject: "Abgesagt: Sync", plainText: "Fällt aus." });
    addAttachment(db, cancel.id, { filename: "cancel.ics", contentType: "text/calendar", size: 200, filePath: icsFile("cancel.ics", "CANCEL") });
    expect(explainEmail(db, user.id, cancel.id).reasons.find(r => r.signal === "a calendar invitation")?.detail).toBe("CANCEL");
  });

  test("a calendar file that is missing or unreadable still counts as one; a plain mail has none; PUBLISH is only an announcement", async () => {
    const { db, user, account, mail } = await setup();
    const gone = mail(account.id, { from: PERSON("anna@becker.example", "Anna"), subject: "Termin", plainText: "Hi Philipp, siehe Anhang." });
    addAttachment(db, gone.id, { filename: "termin.ics", size: 1, filePath: "/nonexistent/termin.ics" });
    expect(explainEmail(db, user.id, gone.id).reasons.find(r => r.signal === "a calendar invitation")?.detail).toBe("calendar file");

    const none = mail(account.id, { from: PERSON("anna@becker.example", "Anna"), subject: "Termin", plainText: "Hi Philipp, Freitag?" });
    expect(signalsOf(db, user.id, none.id).some(sig => sig.includes("calendar"))).toBe(false);

    const publish = mail(account.id, { from: PERSON("events@meetup.example", "Meetup"), subject: "Event", plainText: "Kommt vorbei." });
    addAttachment(db, publish.id, { filename: "event.ics", contentType: "text/calendar", size: 200, filePath: icsFile("event.ics", "PUBLISH") });
    expect(signalsOf(db, user.id, publish.id).some(sig => sig.startsWith("an event announcement"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the imbox's unread count", () => {
  test("counts unread messages that are in the imbox — only those, in incoming folders", async () => {
    const { db, user, account, other, mail } = await setup();
    const a = mail(account.id, { from: PERSON("a@x.example"), subject: "A" });
    const b = mail(other.id, { from: PERSON("b@x.example"), subject: "B" });
    const read = mail(account.id, { from: PERSON("c@x.example"), subject: "C", isRead: true });
    const notImportant = mail(account.id, { from: PERSON("d@x.example"), subject: "D" });
    mail(account.id, { from: PERSON("e@x.example"), subject: "E (unclassified)" });
    for (const id of [a.id, b.id, read.id]) setImbox(db, id, true);
    setImbox(db, notImportant.id, false);

    expect(countUnifiedInboxUnread(db, user.id, { imbox: true })).toBe(2);
    expect(countUnifiedInboxUnread(db, user.id)).toBe(4); // the Inbox's own count is unchanged: everything unread
  });
});
