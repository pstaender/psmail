import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount } from "../../src/server/models/accounts";
import {
  completeDownloadJob,
  createDownloadJob,
  failDownloadJob,
  getDownloadJob,
  listDownloadJobs,
  startDownloadJob,
  updateDownloadProgress,
} from "../../src/server/models/downloads";
import { ApiError } from "../../src/server/types";

async function setupAccount(db: ReturnType<typeof createTestDb>) {
  const user = await createUser(db, "alice", "pw");
  const key = deriveEncryptionKey("pw", generateSalt());
  return createAccount(
    db,
    user.id,
    {
      email: "me@example.com",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecure: true,
      imapUsername: "me@example.com",
      imapPassword: "x",
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      smtpUsername: "me@example.com",
      smtpPassword: "x",
    },
    key
  );
}

describe("downloads (job queue) model", () => {
  test("creates a pending job for a folder", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);

    const job = createDownloadJob(db, account.id, "INBOX");
    expect(job.status).toBe("pending");
    expect(job.progressCurrent).toBe(0);
  });

  test("only one active job per account at a time", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);

    createDownloadJob(db, account.id, "INBOX");
    expect(() => createDownloadJob(db, account.id, "INBOX")).toThrow(ApiError);
  });

  test("a new job can be created once the previous one completed", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);

    const job = createDownloadJob(db, account.id, "INBOX");
    startDownloadJob(db, job.id, 10);
    completeDownloadJob(db, job.id);

    const second = createDownloadJob(db, account.id, "INBOX");
    expect(second.id).not.toBe(job.id);
  });

  test("tracks progress and completion", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);

    const job = createDownloadJob(db, account.id, "INBOX");
    startDownloadJob(db, job.id, 3);
    updateDownloadProgress(db, job.id, 1);
    updateDownloadProgress(db, job.id, 2);
    const completed = completeDownloadJob(db, job.id);

    expect(completed.status).toBe("completed");
    expect(getDownloadJob(db, job.id).progressCurrent).toBe(2);
    expect(completed.finishedAt).not.toBeNull();
  });

  test("failing a job records the error and frees the account for a new job", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);

    const job = createDownloadJob(db, account.id, "INBOX");
    startDownloadJob(db, job.id, 5);
    const failed = failDownloadJob(db, job.id, "connection refused");

    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("connection refused");
    expect(() => createDownloadJob(db, account.id, "INBOX")).not.toThrow();
  });

  test("lists jobs for an account, newest first", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);

    const first = createDownloadJob(db, account.id, "INBOX");
    completeDownloadJob(db, first.id);
    const second = createDownloadJob(db, account.id, "INBOX");

    const jobs = listDownloadJobs(db, account.id);
    expect(jobs.map(j => j.id)).toEqual([second.id, first.id]);
  });
});
