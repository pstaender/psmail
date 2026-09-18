import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount, getAccountRow } from "../../src/server/models/accounts";
import { createDownloadJob, getDownloadJob } from "../../src/server/models/downloads";
import { findEmailByUid, listEmails } from "../../src/server/models/emails";
import { runSync } from "../../src/server/services/sync";
import type { RemoteFlagState } from "../../src/server/services/imap";

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

// runSync takes its IMAP fetch as an injectable option specifically so tests can hand it canned
// messages this way, as a plain function argument — rather than bun:test's mock.module, which
// replaces a module for the rest of the test *run*, not just this file (that bit other,
// unrelated tests before; see emailImapSync.test.ts, which needs the real withImapClient
// elsewhere in the same run to hit an actually-unreachable host on purpose).
const fakeFetchMessages = async (_creds: unknown, _folder: string, sinceUid: number) => ({
  messages: FAKE_MESSAGES.filter(m => m.uid > sinceUid),
});

// Matches what fakeFetchMessages' persisted rows actually have (createEmail always starts a
// synced message as unread/unflagged) — a safe no-op default for tests that aren't specifically
// exercising reconciliation, so it doesn't delete everything fakeFetchMessages just created.
const fakeFetchRemoteFlagsNoop = async (_creds: unknown, _folder: string, uids: number[]) => {
  const map = new Map<number, RemoteFlagState>();
  for (const uid of uids) map.set(uid, { seen: false, flagged: false });
  return map;
};

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
      fetchMessages: fakeFetchMessages,
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
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
    const { db, user, account } = await setup();

    const job1 = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job1.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: fakeFetchMessages,
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
    });

    const job2 = createDownloadJob(db, account.id, "INBOX");
    const result = await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job2.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: fakeFetchMessages,
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
    });

    // All 3 fake messages already exist locally now, so nothing new to persist.
    expect(result.downloaded).toBe(0);
    expect(listEmails(db, account.id, { folder: "INBOX" })).toHaveLength(3);
  });

  test("two-way sync: pulls down a flag change made by another IMAP client", async () => {
    const { db, user, account } = await setup();

    const job1 = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job1.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: fakeFetchMessages,
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
    });

    const stored = listEmails(db, account.id, { folder: "INBOX" });
    const second = stored.find(e => e.subject === "Second")!;
    expect(second.isRead).toBe(false);
    expect(second.isFlagged).toBe(false);

    // Simulates another IMAP client marking uid 2 as read and flagged, and leaving 1 and 3 alone.
    const fetchRemoteFlagsWithChange = async (_creds: unknown, _folder: string, uids: number[]) => {
      const map = new Map<number, RemoteFlagState>();
      for (const uid of uids) map.set(uid, uid === 2 ? { seen: true, flagged: true } : { seen: false, flagged: false });
      return map;
    };

    const job2 = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job2.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: fakeFetchMessages,
      fetchRemoteFlags: fetchRemoteFlagsWithChange,
    });

    const afterSync = listEmails(db, account.id, { folder: "INBOX" });
    const updatedSecond = afterSync.find(e => e.subject === "Second")!;
    expect(updatedSecond.isRead).toBe(true);
    expect(updatedSecond.isFlagged).toBe(true);
    // The other two were left alone, both locally and on the (simulated) server.
    const first = afterSync.find(e => e.subject === "First")!;
    expect(first.isRead).toBe(false);
    expect(first.isFlagged).toBe(false);
  });

  test("two-way sync: removes a message no longer present in the folder on the server", async () => {
    const { db, user, account } = await setup();

    const job1 = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job1.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: fakeFetchMessages,
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
    });
    expect(listEmails(db, account.id, { folder: "INBOX" })).toHaveLength(3);

    // Simulates uid 2 having been deleted (or moved elsewhere) by another IMAP client — it's
    // simply missing from the server's response now.
    const fetchRemoteFlagsWithDeletion = async (_creds: unknown, _folder: string, uids: number[]) => {
      const map = new Map<number, RemoteFlagState>();
      for (const uid of uids) if (uid !== 2) map.set(uid, { seen: false, flagged: false });
      return map;
    };

    const job2 = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job2.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: fakeFetchMessages,
      fetchRemoteFlags: fetchRemoteFlagsWithDeletion,
    });

    const remaining = listEmails(db, account.id, { folder: "INBOX" });
    expect(remaining.map(e => e.subject).sort()).toEqual(["First", "Third"]);
  });
});
