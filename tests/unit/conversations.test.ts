import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount } from "../../src/server/models/accounts";
import { createEmail, getEmail, listEmails, updateEmail } from "../../src/server/models/emails";
import { conversationInfoFor, getConversation } from "../../src/server/models/conversations";
import { listUnifiedEmails } from "../../src/server/models/unified";
import { searchEmails } from "../../src/server/models/search";

const key = deriveEncryptionKey("pw", generateSalt());
const input = (email: string) => ({
  email, imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: email, imapPassword: "x",
  smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: email, smtpPassword: "x",
});
const ME = "me@example.com";
const person = (address: string, name = "Anna") => [{ name, address }];

async function setup() {
  const db = createTestDb();
  const user = await createUser(db, "me", "pw");
  const account = createAccount(db, user.id, input(ME), key);
  const work = createAccount(db, user.id, input("me@work.example.org"), key);
  let day = 0;
  const mail = (accountId: number, over: Record<string, unknown>) =>
    createEmail(db, accountId, {
      folder: "INBOX", isDraft: false, plainText: "text", to: [{ address: ME }],
      date: `2026-06-${String(++day).padStart(2, "0")}T10:00:00.000Z`, ...over,
    });
  return { db, user, account, work, mail };
}

describe("what a list needs to know: answered, and related", () => {
  test("a message the user answered is 'replied'; the answer and its parent are related; unrelated mail says nothing", async () => {
    const { db, user, account, mail } = await setup();
    const question = mail(account.id, { from: person("anna@x.example"), subject: "Frage", messageId: "<q@x>" });
    const answer = mail(account.id, { folder: "Sent", from: [{ address: ME }], to: person("anna@x.example"), subject: "Re: Frage", messageId: "<a@me>", inReplyTo: "<q@x>" });
    const alone = mail(account.id, { from: person("bob@x.example"), subject: "Etwas", messageId: "<b@x>" });

    const info = conversationInfoFor(db, user.id, [question.id, answer.id, alone.id]);
    expect(info.get(question.id)).toEqual({ replied: true, forwarded: false, related: 1 });
    expect(info.get(answer.id)).toEqual({ replied: false, forwarded: false, related: 1 }); // it answers something that is stored
    expect(info.has(alone.id)).toBe(false);
  });

  test("an answer from someone else makes it related but not 'replied'; several answers count", async () => {
    const { db, user, account, mail } = await setup();
    const post = mail(account.id, { from: person("anna@x.example"), messageId: "<p@x>" });
    mail(account.id, { from: person("bob@x.example"), messageId: "<r1@x>", inReplyTo: "<p@x>" });
    mail(account.id, { from: person("cy@x.example"), messageId: "<r2@x>", inReplyTo: "<p@x>" });
    expect(conversationInfoFor(db, user.id, [post.id]).get(post.id)).toEqual({ replied: false, forwarded: false, related: 2 });
  });

  test("a forwarded message is marked in every list and in the conversation, even without relatives; it stays forwarded", async () => {
    const { db, user, account, mail } = await setup();
    const plain = mail(account.id, { from: person("anna@x.example"), subject: "Weiter", messageId: "<w@x>" });
    const other = mail(account.id, { from: person("bob@x.example"), subject: "Nicht", messageId: "<n@x>" });
    expect(conversationInfoFor(db, user.id, [plain.id]).size).toBe(0);

    updateEmail(db, plain.id, { isForwarded: true });
    expect(conversationInfoFor(db, user.id, [plain.id, other.id]).get(plain.id)).toEqual({ replied: false, forwarded: true, related: 0 });
    expect(conversationInfoFor(db, user.id, [other.id]).size).toBe(0);
    expect(listUnifiedEmails(db, user.id, "inbox").find(r => r.id === plain.id)?.conversation).toEqual({ replied: false, forwarded: true, related: 0 });
    expect(getConversation(db, user.id, plain.id).messages[0]).toMatchObject({ current: true, forwarded: true });
    expect(getEmail(db, plain.id).isForwarded).toBe(true);

    updateEmail(db, plain.id, { isForwarded: false }); // it can't be taken back
    expect(getEmail(db, plain.id).isForwarded).toBe(true);
  });

  test("a reply whose parent isn't stored is not related to anything; drafts don't answer", async () => {
    const { db, user, account, mail } = await setup();
    const orphan = mail(account.id, { from: person("anna@x.example"), messageId: "<o@x>", inReplyTo: "<gone@x>" });
    const question = mail(account.id, { from: person("anna@x.example"), messageId: "<q@x>" });
    mail(account.id, { folder: "Drafts", isDraft: true, from: [{ address: ME }], messageId: "<d@me>", inReplyTo: "<q@x>" });
    expect(conversationInfoFor(db, user.id, [orphan.id, question.id]).size).toBe(0);
  });

  test("an answer sent from another of the user's accounts counts; someone else's mail never leaks in", async () => {
    const { db, user, account, work, mail } = await setup();
    const question = mail(account.id, { from: person("anna@x.example"), messageId: "<q@x>" });
    mail(work.id, { folder: "Sent", from: [{ address: "me@work.example.org" }], messageId: "<a@work>", inReplyTo: "<q@x>" });
    expect(conversationInfoFor(db, user.id, [question.id]).get(question.id)?.replied).toBe(true);

    const stranger = await createUser(db, "other", "pw");
    expect(conversationInfoFor(db, stranger.id, [question.id]).size).toBe(0); // not their message
  });

  test("the message lists carry it: folder list rows, the combined lists and search results — and only where there is something to say", async () => {
    const { db, user, account, mail } = await setup();
    const question = mail(account.id, { from: person("anna@x.example"), subject: "Frage", messageId: "<q@x>" });
    mail(account.id, { folder: "Sent", from: [{ address: ME }], subject: "Re: Frage", messageId: "<a@me>", inReplyTo: "<q@x>" });
    mail(account.id, { from: person("bob@x.example"), subject: "Ruhig", messageId: "<b@x>" });

    const folder = listEmails(db, account.id, { folder: "INBOX" });
    expect(folder).toHaveLength(2);
    // (the folder route adds it; the model functions for the combined lists and search do it themselves)
    const unified = listUnifiedEmails(db, user.id, "inbox");
    expect(unified.find(r => r.id === question.id)?.conversation).toEqual({ replied: true, forwarded: false, related: 1 });
    expect(unified.find(r => r.subject === "Ruhig")).not.toHaveProperty("conversation");
    expect(searchEmails(db, user.id, "Frage").find(r => r.id === question.id)?.conversation).toEqual({ replied: true, forwarded: false, related: 1 });
  });
});

describe("the conversation of one message", () => {
  test("a chain is found from any of its messages, oldest first, with the asked-for one marked", async () => {
    const { db, user, account, mail } = await setup();
    const a = mail(account.id, { from: person("anna@x.example"), subject: "Projekt", messageId: "<1@x>", plainText: "Hallo, wie weit seid ihr?" });
    const b = mail(account.id, { folder: "Sent", from: [{ address: ME }], subject: "Re: Projekt", messageId: "<2@me>", inReplyTo: "<1@x>", plainText: "Fast fertig." });
    const c = mail(account.id, { from: person("anna@x.example"), subject: "Re: Projekt", messageId: "<3@x>", inReplyTo: "<2@me>", plainText: "Super, danke." });

    for (const start of [a, b, c]) {
      const conversation = getConversation(db, user.id, start.id);
      expect(conversation.messages.map(m => m.id)).toEqual([a.id, b.id, c.id]);
      expect(conversation.messages.filter(m => m.current).map(m => m.id)).toEqual([start.id]);
    }
    const middle = getConversation(db, user.id, b.id);
    expect(middle.messages.map(m => [m.own, m.folder, m.snippet])).toEqual([
      [false, "INBOX", "Hallo, wie weit seid ihr?"],
      [true, "Sent", "Fast fertig."],
      [false, "INBOX", "Super, danke."],
    ]);
    expect(middle.messages[0]!.from).toMatchObject({ address: "anna@x.example" });
    expect(middle.messages[0]!.accountEmail).toBe(ME);
  });

  test("References link a message to earlier ones even when the ones in between are missing", async () => {
    const { db, user, account, mail } = await setup();
    const root = mail(account.id, { from: person("anna@x.example"), messageId: "<root@x>" });
    const late = mail(account.id, { from: person("bob@x.example"), messageId: "<late@x>", inReplyTo: "<missing@x>", headersRaw: "References: <root@x>\n <missing@x>\nSubject: Re" });
    expect(getConversation(db, user.id, late.id).messages.map(m => m.id)).toEqual([root.id, late.id]);
    expect(getConversation(db, user.id, root.id).messages.map(m => m.id)).toEqual([root.id]); // a References-only child isn't found from the parent; the walk goes by In-Reply-To downwards
  });

  test("a reply that was stored before its parent is found from the parent too (children by In-Reply-To)", async () => {
    const { db, user, account, mail } = await setup();
    const reply = mail(account.id, { from: person("bob@x.example"), messageId: "<r@x>", inReplyTo: "<p@x>" });
    const parent = mail(account.id, { from: person("anna@x.example"), messageId: "<p@x>" });
    expect(getConversation(db, user.id, parent.id).messages.map(m => m.id).sort()).toEqual([reply.id, parent.id].sort());
  });

  test("across accounts: my answer from another account belongs to it", async () => {
    const { db, user, account, work, mail } = await setup();
    const q = mail(account.id, { from: person("anna@x.example"), messageId: "<q@x>" });
    const a = mail(work.id, { folder: "Sent", from: [{ address: "me@work.example.org" }], messageId: "<a@work>", inReplyTo: "<q@x>" });
    const conversation = getConversation(db, user.id, q.id);
    expect(conversation.messages.map(m => [m.id, m.accountEmail])).toEqual([[q.id, ME], [a.id, "me@work.example.org"]]);
    expect(conversation.repliedBy).toBe(a.id);
  });

  test("repliedBy is the user's newest answer to exactly this message; someone else's answer isn't one", async () => {
    const { db, user, account, mail } = await setup();
    const q = mail(account.id, { from: person("anna@x.example"), messageId: "<q@x>" });
    expect(getConversation(db, user.id, q.id).repliedBy).toBeNull();
    mail(account.id, { from: person("bob@x.example"), messageId: "<b@x>", inReplyTo: "<q@x>" });
    expect(getConversation(db, user.id, q.id).repliedBy).toBeNull();
    mail(account.id, { folder: "Sent", from: [{ address: ME }], messageId: "<a1@me>", inReplyTo: "<q@x>" });
    const newer = mail(account.id, { folder: "Sent", from: [{ address: ME }], messageId: "<a2@me>", inReplyTo: "<q@x>" });
    expect(getConversation(db, user.id, q.id).repliedBy).toBe(newer.id);
    // and for the answer itself there is nothing to "see"
    expect(getConversation(db, user.id, newer.id).repliedBy).toBeNull();
  });

  test("copies of one message in several folders are one message; drafts are left out; a message alone is a conversation of one", async () => {
    const { db, user, account, mail } = await setup();
    const q = mail(account.id, { from: person("anna@x.example"), messageId: "<q@x>" });
    mail(account.id, { folder: "Archive", from: person("anna@x.example"), messageId: "<q@x>" }); // the same message, labelled twice
    mail(account.id, { folder: "Drafts", isDraft: true, from: [{ address: ME }], messageId: "<d@me>", inReplyTo: "<q@x>" });
    expect(getConversation(db, user.id, q.id).messages.map(m => m.id)).toEqual([q.id]);
  });

  test("a message that isn't the user's (or doesn't exist) is not found; a draft has no conversation", async () => {
    const { db, user, account, mail } = await setup();
    const q = mail(account.id, { from: person("anna@x.example"), messageId: "<q@x>" });
    const draft = mail(account.id, { folder: "Drafts", isDraft: true, from: [{ address: ME }] });
    const stranger = await createUser(db, "other", "pw");
    expect(() => getConversation(db, stranger.id, q.id)).toThrow();
    expect(() => getConversation(db, user.id, 9999)).toThrow();
    expect(() => getConversation(db, user.id, draft.id)).toThrow();
  });

  test("a long thread is cut at 60 messages, and a loop in the references doesn't hang", async () => {
    const { db, user, account, mail } = await setup();
    let previous = "";
    let firstId = 0;
    for (let i = 0; i < 80; i++) {
      const created = mail(account.id, { from: person("anna@x.example"), messageId: `<m${i}@x>`, inReplyTo: previous || null, date: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00.000Z` });
      if (i === 0) firstId = created.id;
      previous = `<m${i}@x>`;
    }
    expect(getConversation(db, user.id, firstId).messages.length).toBeLessThanOrEqual(60);

    const a = mail(account.id, { from: person("a@x.example"), messageId: "<loopA@x>", inReplyTo: "<loopB@x>" });
    mail(account.id, { from: person("b@x.example"), messageId: "<loopB@x>", inReplyTo: "<loopA@x>" });
    expect(getConversation(db, user.id, a.id).messages).toHaveLength(2);
  });
});

describe("it stays fast", () => {
  test("a page of 100 messages out of 100 000: the lookups ride on the indexes", async () => {
    const { db, user, account } = await setup();
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO emails (account_id, folder, uid, is_draft, subject, from_addr, message_id, in_reply_to, date) VALUES (?, 'INBOX', ?, 0, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 100_000; i++) {
      insert.run(account.id, i, `S${i}`, JSON.stringify([{ address: `p${i % 90}@x.example` }]), `<${i}@x>`, i % 3 === 0 && i > 0 ? `<${i - 1}@x>` : null, new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString());
    }
    db.exec("COMMIT");

    const plan = db.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT in_reply_to, from_addr FROM emails WHERE in_reply_to IN ('<1@x>','<2@x>') AND is_draft = 0").all().map(r => r.detail).join(" | ");
    expect(plan).toContain("idx_emails_in_reply_to");

    const ids = db.query<{ id: number }, []>("SELECT id FROM emails ORDER BY id DESC LIMIT 100").all().map(r => r.id);
    const t = performance.now();
    const info = conversationInfoFor(db, user.id, ids);
    const ms = performance.now() - t;
    expect(info.size).toBeGreaterThan(0);
    expect(ms).toBeLessThan(150);

    const t2 = performance.now();
    getConversation(db, user.id, ids[0]!);
    expect(performance.now() - t2).toBeLessThan(150);
  });
});
