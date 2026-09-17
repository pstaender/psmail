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
});
