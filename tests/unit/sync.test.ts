import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount, getAccountRow } from "../../src/server/models/accounts";
import { createDownloadJob, getDownloadJob } from "../../src/server/models/downloads";
import { findEmailByUid, listEmails } from "../../src/server/models/emails";

function rawMessage(opts: { uid: number; subject: string; withAttachment?: boolean }): string {
  const lines = [
    `Message-ID: <${opts.uid}@example.com>`,
    "From: Sender <sender@example.com>",
    "To: me@example.com",
    `Subject: ${opts.subject}`,
    "Date: Mon, 01 Jan 2024 10:00:00 +0000",
  ];

  if (opts.withAttachment) {
    lines.push('Content-Type: multipart/mixed; boundary="B"', "", "--B", "Content-Type: text/plain", "", `Body for ${opts.subject}`, "", "--B", 'Content-Type: text/plain; name="f.txt"', 'Content-Disposition: attachment; filename="f.txt"', "", "attachment body", "", "--B--", "");
  } else {
    lines.push("", `Body for ${opts.subject}`, "");
  }

  return lines.join("\r\n");
}

const FAKE_MESSAGES = [
  { uid: 1, source: Buffer.from(rawMessage({ uid: 1, subject: "First" })) },
  { uid: 2, source: Buffer.from(rawMessage({ uid: 2, subject: "Second", withAttachment: true })) },
  { uid: 3, source: Buffer.from(rawMessage({ uid: 3, subject: "Third" })) },
].map(m => ({ ...m, size: m.source.length }));

mock.module("../../src/server/services/imap", () => ({
  withImapClient: async (_creds: unknown, fn: (client: unknown) => Promise<unknown>) => fn({}),
  fetchNewMessages: async (_client: unknown, _folder: string, sinceUid: number) => ({
    mailbox: { uidNext: FAKE_MESSAGES.length + 1 },
    messages: FAKE_MESSAGES.filter(m => m.uid > sinceUid),
  }),
}));

describe("runSync", () => {
  let configDir: string;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "psmail-sync-test-"));
    process.env.PSMAIL_CONFIG_DIR = configDir;
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
    delete process.env.PSMAIL_CONFIG_DIR;
  });

  async function setup() {
    const db = createTestDb();
    const user = await createUser(db, "alice", "pw");
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
        imapPassword: "imap-pw",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "me@example.com",
        smtpPassword: "smtp-pw",
      },
      key
    );
    return { db, user, account: getAccountRow(db, account.id) };
  }

  test("downloads all new messages, persisting fields and attachments", async () => {
    const { runSync } = await import("../../src/server/services/sync");
    const { db, user, account } = await setup();

    const job = createDownloadJob(db, account.id, "INBOX");
    const progressUpdates: { current: number; total: number }[] = [];

    const result = await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      onProgress: p => progressUpdates.push(p),
    });

    expect(result.downloaded).toBe(3);

    const stored = listEmails(db, account.id, { folder: "INBOX" });
    expect(stored).toHaveLength(3);
    expect(stored.map(e => e.subject).sort()).toEqual(["First", "Second", "Third"]);

    const withAttachment = stored.find(e => e.subject === "Second")!;
    const full = findEmailByUid(db, account.id, "INBOX", 2);
    expect(full).not.toBeNull();

    expect(progressUpdates[0]).toEqual({ current: 0, total: 3 });
    expect(progressUpdates.at(-1)).toEqual({ current: 3, total: 3 });

    const job2 = getDownloadJob(db, job.id);
    expect(job2.status).toBe("completed");
    expect(job2.progressCurrent).toBe(3);
  });

  test("incremental sync only fetches messages newer than the highest stored uid", async () => {
    const { runSync } = await import("../../src/server/services/sync");
    const { db, user, account } = await setup();

    const job1 = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job1.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
    });

    const job2 = createDownloadJob(db, account.id, "INBOX");
    const result = await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job2.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
    });

    // All 3 fake messages already exist locally now, so nothing new to persist.
    expect(result.downloaded).toBe(0);
    expect(listEmails(db, account.id, { folder: "INBOX" })).toHaveLength(3);
  });
});
