/**
 * End-to-end test against a real IMAP/SMTP server (Greenmail), exercising the
 * actual imapflow + nodemailer + mailparser code paths that the mocked
 * tests/unit/sync.test.ts stubs out.
 *
 * Requires Docker. Start the test server first:
 *   docker compose -f docker/greenmail.yml up -d
 * Then run:
 *   RUN_IMAP_INTEGRATION=1 bun test tests/integration/imap-sync.test.ts
 *
 * Skipped by default (and by the plain `bun test` run) since it needs an
 * external service.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";

const RUN = process.env.RUN_IMAP_INTEGRATION === "1";

const GREENMAIL_HOST = "127.0.0.1";
const GREENMAIL_SMTP_PORT = 3025;
const GREENMAIL_IMAP_PORT = 3143;
const GREENMAIL_USER = "psmail";
const GREENMAIL_PASSWORD = "psmail-test-pw";
const MAILBOX_EMAIL = "psmail@example.com";

describe.skipIf(!RUN)("IMAP sync against a real server (Greenmail)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "psmail-imap-test-"));
  process.env.PSMAIL_CONFIG_DIR = configDir;

  const db = createTestDb();
  const server = startTestServer(db);
  const base = server.url.toString().replace(/\/$/, "");

  afterAll(() => {
    server.stop(true);
    rmSync(configDir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }

  async function sendViaGreenmail(subject: string, text: string) {
    const transporter = nodemailer.createTransport({
      host: GREENMAIL_HOST,
      port: GREENMAIL_SMTP_PORT,
      secure: false,
      auth: { user: GREENMAIL_USER, pass: GREENMAIL_PASSWORD },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({ from: MAILBOX_EMAIL, to: MAILBOX_EMAIL, subject, text });
    transporter.close();
  }

  async function waitForJob(accountEmail: string, jobId: number, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { json } = await api("GET", `/api/accounts/${encodeURIComponent(accountEmail)}/downloads/${jobId}`, {
        token,
      });
      if (json.status === "completed" || json.status === "failed") return json;
      await Bun.sleep(300);
    }
    throw new Error(`Download job ${jobId} did not finish within ${timeoutMs}ms`);
  }

  let token: string;

  test("setup: create user, login, create account pointed at Greenmail", async () => {
    await api("POST", "/api/users", { body: { username: "imaptest", password: "pw" } });
    const login = await api("POST", "/api/auth/login", { body: { username: "imaptest", password: "pw" } });
    expect(login.status).toBe(200);
    token = login.json.token;

    const account = await api("POST", "/api/accounts", {
      token,
      body: {
        email: MAILBOX_EMAIL,
        imapHost: GREENMAIL_HOST,
        imapPort: GREENMAIL_IMAP_PORT,
        imapSecure: false,
        imapUsername: GREENMAIL_USER,
        imapPassword: GREENMAIL_PASSWORD,
        smtpHost: GREENMAIL_HOST,
        smtpPort: GREENMAIL_SMTP_PORT,
        smtpSecure: false,
        smtpUsername: GREENMAIL_USER,
        smtpPassword: GREENMAIL_PASSWORD,
      },
    });
    expect(account.status).toBe(201);
  });

  test("syncs a message that was delivered via SMTP", async () => {
    await sendViaGreenmail("Integration test message", "Hello from Greenmail");

    const job = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/downloads`, {
      token,
      body: { folder: "INBOX" },
    });
    expect(job.status).toBe(202);

    const finished = await waitForJob(MAILBOX_EMAIL, job.json.id);
    expect(finished.status).toBe("completed");
    expect(finished.progressCurrent).toBeGreaterThanOrEqual(1);

    const emails = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails?folder=INBOX`, {
      token,
    });
    expect(emails.status).toBe(200);
    const match = emails.json.find((e: { subject: string }) => e.subject === "Integration test message");
    expect(match).toBeDefined();
    expect(match.plainText).toContain("Hello from Greenmail");
  });

  test("sending a draft via the API delivers it back into the same mailbox", async () => {
    const draft = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails`, {
      token,
      body: {
        from: [{ address: MAILBOX_EMAIL }],
        to: [{ address: MAILBOX_EMAIL }],
        subject: "Sent via API",
        plainText: "Round-trip test",
      },
    });
    expect(draft.status).toBe(201);

    const sent = await api(
      "POST",
      `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails/${draft.json.id}/send`,
      { token }
    );
    expect(sent.status).toBe(200);

    const job = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/downloads`, {
      token,
      body: { folder: "INBOX" },
    });
    const finished = await waitForJob(MAILBOX_EMAIL, job.json.id);
    expect(finished.status).toBe("completed");

    const emails = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails?folder=INBOX`, {
      token,
    });
    const match = emails.json.find((e: { subject: string }) => e.subject === "Sent via API");
    expect(match).toBeDefined();
  });

  test("sending a draft also appends a copy into the account's Sent folder", async () => {
    const draft = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails`, {
      token,
      body: {
        from: [{ address: MAILBOX_EMAIL }],
        to: [{ address: MAILBOX_EMAIL }],
        subject: "Sent-folder copy check",
        plainText: "Does a copy land in Sent?",
      },
    });
    expect(draft.status).toBe(201);

    const sent = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails/${draft.json.id}/send`, {
      token,
    });
    expect(sent.status).toBe(200);
    expect(sent.json.folder).toBe("Sent");
    expect(sent.json.uid).not.toBeNull(); // successfully APPENDed, so it now has a real server UID

    const job = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/downloads`, {
      token,
      body: { folder: "Sent" },
    });
    const finished = await waitForJob(MAILBOX_EMAIL, job.json.id);
    expect(finished.status).toBe("completed");

    const sentEmails = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails?folder=Sent`, {
      token,
    });
    const match = sentEmails.json.find((e: { subject: string }) => e.subject === "Sent-folder copy check");
    expect(match).toBeDefined();
  });

  test("sending from a read-only account still files the local copy under the account's real Sent folder, without writing to the server", async () => {
    // A read-only account must never append — but it can still read (list folders), which is all resolving the real Sent
    // path needs; before the fix this fell back to a hardcoded "Sent" instead, which is wrong for a server that calls it
    // something else (e.g. Gmail's "[Gmail]/Sent Mail") and made the message look like it never arrived.
    const roToggle = await api("PATCH", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}`, { token, body: { readOnly: true } });
    expect(roToggle.status).toBe(200);

    const draft = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails`, {
      token,
      body: {
        from: [{ address: MAILBOX_EMAIL }],
        to: [{ address: MAILBOX_EMAIL }],
        subject: "Read-only account, sent-folder placement",
        plainText: "Should file under the real Sent folder, not a guess.",
      },
    });
    expect(draft.status).toBe(201);

    const sent = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails/${draft.json.id}/send`, {
      token,
    });
    expect(sent.status).toBe(200);
    expect(sent.json.uid).toBeNull(); // nothing was appended — a read-only account never writes

    const folders = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/folders`, { token });
    const realSent = folders.json.find((f: { specialUse: string | null }) => f.specialUse === "\\Sent");
    expect(realSent).toBeDefined();
    expect(sent.json.folder).toBe(realSent.path); // resolved from the live listing, not a hardcoded guess

    // Restore write access for the tests that follow.
    expect((await api("PATCH", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}`, { token, body: { readOnly: false } })).status).toBe(200);
  });

  test("deleting a synced message soft-deletes (moves to Trash) once UIDPLUS support is confirmed", async () => {
    const check = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/imap-capabilities`, { token });
    expect(check.status).toBe(200);
    expect(check.json.supportsUidPlus).toBe(true); // Greenmail supports UIDPLUS

    await sendViaGreenmail("To be soft-deleted", "Trash me");
    const job = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/downloads`, {
      token,
      body: { folder: "INBOX" },
    });
    await waitForJob(MAILBOX_EMAIL, job.json.id);

    const emails = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails?folder=INBOX`, {
      token,
    });
    const target = emails.json.find((e: { subject: string }) => e.subject === "To be soft-deleted");
    expect(target).toBeDefined();

    const del = await api("DELETE", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails/${target.id}`, { token });
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ softDeleted: true });

    const moved = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails/${target.id}`, { token });
    expect(moved.json.folder).toBe("Trash");
  });

  test("two-way sync pulls down a flag change made by another IMAP client", async () => {
    await sendViaGreenmail("Flag me externally", "Watch this get marked read");
    const job1 = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/downloads`, {
      token,
      body: { folder: "INBOX" },
    });
    await waitForJob(MAILBOX_EMAIL, job1.json.id);

    const before = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails?folder=INBOX`, {
      token,
    });
    const target = before.json.find((e: { subject: string }) => e.subject === "Flag me externally");
    expect(target.isRead).toBe(false);

    // A different IMAP client (not this app) marks it \Seen directly on the server.
    const client = new ImapFlow({
      host: GREENMAIL_HOST,
      port: GREENMAIL_IMAP_PORT,
      secure: false,
      auth: { user: GREENMAIL_USER, pass: GREENMAIL_PASSWORD },
      logger: false,
    });
    await client.connect();
    await client.mailboxOpen("INBOX");
    await client.messageFlagsAdd({ uid: target.uid }, ["\\Seen"], { uid: true });
    await client.logout();

    const job2 = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/downloads`, {
      token,
      body: { folder: "INBOX" },
    });
    await waitForJob(MAILBOX_EMAIL, job2.json.id);

    const after = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails/${target.id}`, { token });
    expect(after.json.isRead).toBe(true);
  });

  test("a draft stays reachable in the sidebar even when Greenmail has no server-side Drafts folder", async () => {
    const draft = await api("POST", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails`, {
      token,
      body: { subject: "Local-only draft", plainText: "No Drafts folder on this server" },
    });
    expect(draft.status).toBe(201);
    // Greenmail's minimal test setup only auto-creates INBOX — nothing here should assume
    // otherwise, since that's exactly the "no Drafts folder at all" case this test is for.
    expect(draft.json.folder).toBe("Drafts");

    const folders = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/folders`, { token });
    expect(folders.status).toBe(200);
    const draftsFolder = folders.json.find((f: { path: string }) => f.path === "Drafts");
    expect(draftsFolder).toBeDefined();
    expect(draftsFolder.total).toBeGreaterThanOrEqual(1);

    const draftsEmails = await api("GET", `/api/accounts/${encodeURIComponent(MAILBOX_EMAIL)}/emails?folder=Drafts`, {
      token,
    });
    expect(draftsEmails.json.some((e: { id: number }) => e.id === draft.json.id)).toBe(true);
  });
});
