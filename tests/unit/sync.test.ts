import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount, getAccountRow } from "../../src/server/models/accounts";
import { createDownloadJob, getDownloadJob } from "../../src/server/models/downloads";
import { createEmail, findEmailByUid, findSentPlaceholderByMessageId, getEmail, listEmails } from "../../src/server/models/emails";
import { performDelete } from "../../src/server/routes/emails";
import { listDeletedUids } from "../../src/server/models/tombstones";
import { isSyncableFolder, runSync } from "../../src/server/services/sync";
import type { ImapFolder, RemoteFlagState } from "../../src/server/services/imap";

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
// A stand-in UIDVALIDITY: none of these tests are about it changing, so every fake reports the same one.
const FAKE_UID_VALIDITY = 1;
const fakeFetchRemoteFlagsNoop = async (_creds: unknown, _folder: string, uids: number[]) => {
  const map = new Map<number, RemoteFlagState>();
  for (const uid of uids) map.set(uid, { seen: false, flagged: false });
  return { uidValidity: FAKE_UID_VALIDITY, flags: map };
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

  test("a message this app already sent — stored locally without a UID — is matched by Message-ID and given the real UID instead of being downloaded a second time", async () => {
    const { db, user, account } = await setup();

    // What POST .../send leaves behind when the server didn't confirm a UID at send time (a read-only account, whose own
    // append is skipped on purpose, or a connection hiccup during the append): the full message, already in "Sent", uid null.
    const placeholder = createEmail(db, account.id, {
      folder: "Sent",
      uid: null,
      isDraft: false,
      messageId: "<2@example.com>", // matches FAKE_MESSAGES' uid-2 message ("Second")
      subject: "Second",
      plainText: "My own composed body — not what the server's copy would parse to.",
    });
    expect(findSentPlaceholderByMessageId(db, account.id, "Sent", "<2@example.com>")?.id).toBe(placeholder.id);

    const job = createDownloadJob(db, account.id, "Sent");
    const result = await runSync({
      db,
      account,
      username: user.username,
      folder: "Sent",
      downloadJobId: job.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: fakeFetchMessages,
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
    });

    expect(result.downloaded).toBe(3); // still counted for progress, same as any other processed message

    const stored = listEmails(db, account.id, { folder: "Sent" });
    expect(stored.map(e => e.messageId).sort()).toEqual(["<1@example.com>", "<2@example.com>", "<3@example.com>"]); // no duplicate
    expect(stored).toHaveLength(3);

    const merged = getEmail(db, placeholder.id);
    expect(merged.uid).toBe(2); // the UID FAKE_MESSAGES actually reports for this Message-ID
    expect(merged.plainText).toBe("My own composed body — not what the server's copy would parse to."); // untouched — not overwritten by the server's copy
    expect(findSentPlaceholderByMessageId(db, account.id, "Sent", "<2@example.com>")).toBeNull(); // no longer a placeholder, now it has a UID
    expect(findEmailByUid(db, account.id, "Sent", 2)?.id).toBe(placeholder.id);
  });

  test("exposes download progress on the job row while messages are still being downloaded", async () => {
    const { db, user, account } = await setup();
    const job = createDownloadJob(db, account.id, "INBOX");

    const seenMidDownload: { status: string; current: number; total: number }[] = [];
    await runSync({
      db,
      account,
      username: user.username,
      folder: "INBOX",
      downloadJobId: job.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: async (creds, folder, sinceUid, hooks) => {
        hooks?.onOpened?.(3);
        for (let count = 1; count <= 3; count++) {
          hooks?.onDownloaded?.(count);
          const row = getDownloadJob(db, job.id);
          seenMidDownload.push({ status: row.status, current: row.progressCurrent, total: row.progressTotal });
        }
        return fakeFetchMessages(creds, folder, sinceUid);
      },
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
    });

    expect(seenMidDownload).toEqual([
      { status: "running", current: 1, total: 3 },
      { status: "running", current: 2, total: 3 },
      { status: "running", current: 3, total: 3 },
    ]);
    expect(getDownloadJob(db, job.id).status).toBe("completed");
  });

  test("allFolders syncs every syncable folder (Inbox first), with progress across all of them, and learns the Sent folder", async () => {
    const { db, user, account } = await setup();
    const job = createDownloadJob(db, account.id, null);
    const folder = (path: string, specialUse: string | null = null, flags: string[] = []): ImapFolder => ({
      path, name: path, delimiter: "/", specialUse, flags,
    });
    const requested: string[] = [];
    const progress: { current: number; total: number }[] = [];

    const result = await runSync({
      db,
      account,
      username: user.username,
      allFolders: true,
      downloadJobId: job.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      listRemoteFolders: async () => [
        folder("Archive"),
        folder("[Gmail]", null, ["\\Noselect"]),
        folder("[Gmail]/All Mail", "\\All"),
        folder("Gesendet", "\\Sent"),
        folder("INBOX", "\\Inbox"),
      ],
      fetchMessages: async (creds, folderPath, sinceUid) => {
        requested.push(folderPath);
        return fakeFetchMessages(creds, folderPath, sinceUid);
      },
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
      onProgress: p => progress.push(p),
    });

    expect(requested).toEqual(["INBOX", "Archive", "Gesendet"]);
    expect(result.downloaded).toBe(9);
    for (const name of ["INBOX", "Archive", "Gesendet"]) expect(listEmails(db, account.id, { folder: name })).toHaveLength(3);

    // Progress is cumulative over the folders, ending at the grand total.
    expect(progress.at(-1)).toEqual({ current: 9, total: 9 });
    const finished = getDownloadJob(db, job.id);
    expect(finished.status).toBe("completed");
    expect([finished.progressCurrent, finished.progressTotal]).toEqual([9, 9]);
    expect(getAccountRow(db, account.id).sent_folder).toBe("Gesendet");
  });

  test("allFolders: one folder failing doesn't stop the others, but the job ends up failed and says which", async () => {
    const { db, user, account } = await setup();
    const job = createDownloadJob(db, account.id, null);
    const result = await runSync({
      db,
      account,
      username: user.username,
      allFolders: true,
      downloadJobId: job.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      listRemoteFolders: async () => [
        { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", flags: [] },
        { path: "Broken", name: "Broken", delimiter: "/", specialUse: null, flags: [] },
      ],
      fetchMessages: async (creds, folderPath, sinceUid) => {
        if (folderPath === "Broken") throw new Error("mailbox is corrupt");
        return fakeFetchMessages(creds, folderPath, sinceUid);
      },
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
    });

    expect(result.downloaded).toBe(3);
    expect(listEmails(db, account.id, { folder: "INBOX" })).toHaveLength(3);
    const failed = getDownloadJob(db, job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Broken");
    expect(failed.error).toContain("mailbox is corrupt");
  });

  test("isSyncableFolder skips unselectable containers and virtual all-mail/flagged views", () => {
    const f = (specialUse: string | null, flags: string[] = []): ImapFolder => ({ path: "x", name: "x", delimiter: "/", specialUse, flags });
    expect(isSyncableFolder(f(null))).toBe(true);
    expect(isSyncableFolder(f("\\Trash"))).toBe(true);
    expect(isSyncableFolder(f(null, ["\\Noselect"]))).toBe(false);
    expect(isSyncableFolder(f(null, ["\\NonExistent"]))).toBe(false);
    expect(isSyncableFolder(f("\\All"))).toBe(false);
    expect(isSyncableFolder(f("\\Flagged"))).toBe(false);
  });

  test("a message deleted locally in a read-only account (even the newest UID) isn't downloaded again by the next sync", async () => {
    const { db, user, account } = await setup();
    db.exec(`UPDATE accounts SET read_only = 1 WHERE id = ${account.id}`);
    const readOnly = getAccountRow(db, account.id);
    const sync = async () => {
      const job = createDownloadJob(db, account.id, "INBOX");
      await runSync({
        db, account: readOnly, username: user.username, folder: "INBOX", downloadJobId: job.id,
        imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
        fetchMessages: fakeFetchMessages,
        fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
      });
    };

    await sync();
    const newest = findEmailByUid(db, account.id, "INBOX", 3)!;
    await performDelete(db, readOnly, newest);
    expect(findEmailByUid(db, account.id, "INBOX", 3)).toBeNull();
    expect(listDeletedUids(db, account.id, "INBOX")).toEqual([3]);

    await sync(); // the server still has UID 3 — it must stay deleted locally
    expect(listEmails(db, account.id, { folder: "INBOX" }).map(e => e.subject).sort()).toEqual(["First", "Second"]);

    // Once the server itself no longer has it, the tombstone is cleaned up.
    const job = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db, account: readOnly, username: user.username, folder: "INBOX", downloadJobId: job.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: async () => ({ messages: [] }),
      fetchRemoteFlags: async (_c, _f, uids) => ({ uidValidity: FAKE_UID_VALIDITY, flags: new Map(uids.filter(uid => uid !== 3).map(uid => [uid, { seen: false, flagged: false }])) }),
    });
    expect(listDeletedUids(db, account.id, "INBOX")).toEqual([]);
  });

  test("disabling the account while a sync runs stops it before anything more is stored", async () => {
    const { db, user, account } = await setup();
    const job = createDownloadJob(db, account.id, "INBOX");

    await expect(
      runSync({
        db,
        account,
        username: user.username,
        folder: "INBOX",
        downloadJobId: job.id,
        imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
        fetchMessages: async (creds, folder, sinceUid) => {
          db.exec(`UPDATE accounts SET disabled = 1 WHERE id = ${account.id}`); // disabled while the download is in flight
          return fakeFetchMessages(creds, folder, sinceUid);
        },
        fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
      })
    ).rejects.toThrow(/disabled during the sync/);

    expect(listEmails(db, account.id, { folder: "INBOX" })).toHaveLength(0);
    const failed = getDownloadJob(db, job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("disabled");
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
      return { uidValidity: FAKE_UID_VALIDITY, flags: map };
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

  test("two-way sync: a message another client marked $Forwarded becomes forwarded here, and stays so", async () => {
    const { db, user, account } = await setup();
    const run = async (forwardedUids: number[]) => {
      const job = createDownloadJob(db, account.id, "INBOX");
      await runSync({
        db, account, username: user.username, folder: "INBOX", downloadJobId: job.id,
        imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
        fetchMessages: fakeFetchMessages,
        fetchRemoteFlags: async (_creds: unknown, _folder: string, uids: number[]) => ({
          uidValidity: FAKE_UID_VALIDITY,
          flags: new Map(uids.map(uid => [uid, { seen: false, flagged: false, forwarded: forwardedUids.includes(uid) }] as [number, RemoteFlagState])),
        }),
      });
      return listEmails(db, account.id, { folder: "INBOX" }).map(e => getEmail(db, e.id));
    };
    expect((await run([])).some(e => e.isForwarded)).toBe(false);
    const forwarded = (await run([2])).filter(e => e.isForwarded);
    expect(forwarded.map(e => e.subject)).toEqual(["Second"]);
    // A server that no longer reports the keyword doesn't undo it.
    expect((await run([])).filter(e => e.isForwarded).map(e => e.subject)).toEqual(["Second"]);
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
      return { uidValidity: FAKE_UID_VALIDITY, flags: map };
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

  test("a UIDVALIDITY change never deletes what's already stored — it asks for a full resync instead, and settles once the new value repeats", async () => {
    const { db, user, account } = await setup();

    const job1 = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db, account, username: user.username, folder: "INBOX", downloadJobId: job1.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: fakeFetchMessages,
      fetchRemoteFlags: fakeFetchRemoteFlagsNoop,
    });
    expect(listEmails(db, account.id, { folder: "INBOX" })).toHaveLength(3);

    // The server renumbered the folder from scratch (a rebuild/repair): a different UIDVALIDITY, and none of the
    // old UIDs (1, 2, 3) resolve to anything any more — the same 3 messages are there, now under UIDs 101-103.
    const RENUMBERED = FAKE_MESSAGES.map((m, i) => ({ ...m, uid: 101 + i }));
    const sinceUidsRequested: number[] = [];
    const fetchRenumbered = async (_creds: unknown, _folder: string, sinceUid: number) => {
      sinceUidsRequested.push(sinceUid);
      return { messages: RENUMBERED.filter(m => m.uid > sinceUid) };
    };
    const fetchRemoteFlagsNewValidity = async (_creds: unknown, _folder: string, _uids: number[]) => ({
      uidValidity: FAKE_UID_VALIDITY + 1,
      flags: new Map<number, RemoteFlagState>(), // none of the old UIDs found — but that must NOT read as "all gone"
    });

    const job2 = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db, account, username: user.username, folder: "INBOX", downloadJobId: job2.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: fetchRenumbered,
      fetchRemoteFlags: fetchRemoteFlagsNewValidity,
    });
    // Nothing lost: the 3 original rows (UIDs 1-3) are still there, plus the same 3 messages freshly discovered
    // under their new UIDs (101-103) — a duplicate is far better than the old behavior, silent permanent deletion.
    const afterRenumbering = listEmails(db, account.id, { folder: "INBOX" });
    expect(afterRenumbering).toHaveLength(6);
    expect(afterRenumbering.filter(e => (e.uid ?? 0) < 100).map(e => e.subject).sort()).toEqual(["First", "Second", "Third"]);
    expect(afterRenumbering.filter(e => (e.uid ?? 0) >= 100).map(e => e.subject).sort()).toEqual(["First", "Second", "Third"]);
    expect(sinceUidsRequested).toEqual([0]); // asked for everything — the old watermark (3) was unusable under the new UIDVALIDITY

    // The new UIDVALIDITY is now the recorded baseline: a THIRD sync reporting the same one again, with UID 102
    // genuinely missing, deletes it normally — reconciliation works again as soon as things are stable.
    const fetchRemoteFlagsStable = async (_creds: unknown, _folder: string, uids: number[]) => {
      const map = new Map<number, RemoteFlagState>();
      for (const uid of uids) if (uid !== 102) map.set(uid, { seen: false, flagged: false });
      return { uidValidity: FAKE_UID_VALIDITY + 1, flags: map };
    };
    const job3 = createDownloadJob(db, account.id, "INBOX");
    await runSync({
      db, account, username: user.username, folder: "INBOX", downloadJobId: job3.id,
      imapCredentials: { host: "x", port: 993, secure: true, username: "x", password: "x" },
      fetchMessages: async () => ({ messages: [] }),
      fetchRemoteFlags: fetchRemoteFlagsStable,
    });
    const finalState = listEmails(db, account.id, { folder: "INBOX" });
    expect(finalState.some(e => e.uid === 102)).toBe(false); // deleted, now that the UIDVALIDITY is confirmed stable
    expect(finalState).toHaveLength(5);
  });
});
