import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount, getAccountRow, learnSpecialFolders } from "../../src/server/models/accounts";
import { createDownloadJob } from "../../src/server/models/downloads";
import { createEmail, findEmailByUid, getEmail } from "../../src/server/models/emails";
import { runSync } from "../../src/server/services/sync";
import type { RemoteFlagState } from "../../src/server/services/imap";

/** A whole raw message, as the IMAP server would deliver it. */
function raw(opts: { uid: number; from: string; subject: string; body: string; headers?: string[] }): Buffer {
  return Buffer.from(
    [
      `Message-ID: <${opts.uid}@sender.example>`,
      `From: ${opts.from}`,
      "To: Philipp Staender <philipp@example.com>",
      `Subject: ${opts.subject}`,
      "Date: Mon, 01 Jun 2026 10:00:00 +0000",
      ...(opts.headers ?? []),
      "",
      opts.body,
      "",
    ].join("\r\n")
  );
}

const noFlags = async (_c: unknown, _f: string, uids: number[]) => ({
  uidValidity: 1,
  flags: new Map<number, RemoteFlagState>(uids.map(uid => [uid, { seen: false, flagged: false }])),
});

describe("new mail is classified for the imbox as it is synced", () => {
  let configDir: string;
  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "psmail-imbox-sync-"));
    process.env.PSMAIL_CONFIG_DIR = configDir;
  });
  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
    delete process.env.PSMAIL_CONFIG_DIR;
  });

  async function setup() {
    const db = createTestDb();
    const user = await createUser(db, "philipp", "pw");
    const key = deriveEncryptionKey("pw", generateSalt());
    const created = createAccount(
      db,
      user.id,
      {
        email: "philipp@example.com", displayName: "Philipp Staender", imapHost: "h", imapPort: 993, imapSecure: true, imapUsername: "p", imapPassword: "x",
        smtpHost: "h", smtpPort: 465, smtpSecure: true, smtpUsername: "p", smtpPassword: "x",
      },
      key
    );
    return { db, user, account: getAccountRow(db, created.id) };
  }

  async function sync(s: Awaited<ReturnType<typeof setup>>, folder: string, messages: Buffer[]) {
    const job = createDownloadJob(s.db, s.account.id, folder);
    await runSync({
      db: s.db,
      account: getAccountRow(s.db, s.account.id),
      username: s.user.username,
      folder,
      downloadJobId: job.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: async (_c: unknown, _f: string, sinceUid: number) => ({
        messages: messages.map((source, i) => ({ uid: i + 1, source, size: source.length })).filter(m => m.uid > sinceUid),
      }),
      fetchRemoteFlags: noFlags,
    });
  }

  test("a person's message is important, a newsletter and a login code are not — each with a stored verdict", async () => {
    const s = await setup();
    // Someone I have written to before, so the mailbox knows them.
    createEmail(s.db, s.account.id, { folder: "Sent", uid: 90, isDraft: false, from: [{ address: "philipp@example.com" }], to: [{ name: "Anna", address: "anna@friend.example" }], subject: "Hi", plainText: "x" });

    await sync(s, "INBOX", [
      raw({ uid: 1, from: "Anna Becker <anna@friend.example>", subject: "Samstag?", body: "Hey Philipp,\r\n\r\nhast du am Samstag Zeit?\r\n\r\nAnna" }),
      raw({ uid: 2, from: "Shop <newsletter@shop.example>", subject: "40% Rabatt nur heute", body: "Sichern Sie sich jetzt Rabatt! Newsletter abbestellen.", headers: ["List-Unsubscribe: <mailto:u@shop.example>", "Precedence: bulk"] }),
      raw({ uid: 3, from: "Bank <security@bank.example>", subject: "Ihr Bestätigungscode", body: "Ihr Bestätigungscode lautet 771204. Der Code ist 5 Minuten gültig." }),
    ]);

    const verdict = (uid: number) => getEmail(s.db, findEmailByUid(s.db, s.account.id, "INBOX", uid)!.id).imbox;
    expect(verdict(1)).toBe(true);
    expect(verdict(2)).toBe(false);
    expect(verdict(3)).toBe(false);
  });

  test("mail synced into Sent, Drafts or Junk gets no verdict (it isn't incoming mail)", async () => {
    const s = await setup();
    learnSpecialFolders(s.db, s.account.id, [{ path: "Junk", specialUse: "\\Junk" }, { path: "Sent", specialUse: "\\Sent" }]);
    const message = raw({ uid: 1, from: "Anna <anna@friend.example>", subject: "Hallo", body: "Hey Philipp, wie gehts?" });
    await sync(s, "Junk", [message]);
    await sync(s, "Sent", [message]);
    for (const folder of ["Junk", "Sent"]) expect(getEmail(s.db, findEmailByUid(s.db, s.account.id, folder, 1)!.id).imbox).toBeNull();
  });

  test("later messages in the same run see the earlier ones: a second mail from an address whose first went to Junk", async () => {
    const s = await setup();
    learnSpecialFolders(s.db, s.account.id, [{ path: "Junk", specialUse: "\\Junk" }]);
    for (let i = 0; i < 3; i++) {
      createEmail(s.db, s.account.id, { folder: "Junk", uid: 50 + i, isDraft: false, from: [{ address: "offers@cheap.example" }], to: [{ address: "philipp@example.com" }], subject: `Spam ${i}`, plainText: "buy" });
    }
    await sync(s, "INBOX", [raw({ uid: 1, from: "Offers <offers@cheap.example>", subject: "Hello", body: "Hi Philipp, a special offer." })]);
    const email = getEmail(s.db, findEmailByUid(s.db, s.account.id, "INBOX", 1)!.id);
    expect(email.imbox).toBe(false);
  });
});
