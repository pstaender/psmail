import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { createEmail, getEmail } from "../../src/server/models/emails";

const configDir = mkdtempSync(join(tmpdir(), "psmail-disabled-test-"));
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
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

describe("a disabled account", () => {
  let token: string;
  let accountId: number;
  let emailId: number;
  const email = "off@example.com";
  const acc = `/api/accounts/${encodeURIComponent(email)}`;

  test("set up: an account (IMAP host that can't be reached) with a message", async () => {
    await api("POST", "/api/users", { body: { username: "dora", password: "pw" } });
    token = (await api("POST", "/api/auth/login", { body: { username: "dora", password: "pw" } })).json.token;
    const created = await api("POST", "/api/accounts", {
      token,
      body: { email, imapHost: "127.0.0.1", imapPort: 1, imapUsername: email, imapPassword: "x", smtpHost: "127.0.0.1", smtpPort: 1, smtpUsername: email, smtpPassword: "y" },
    });
    expect(created.status).toBe(201);
    expect(created.json.disabled).toBe(false);
    accountId = created.json.id;
    emailId = createEmail(db, accountId, { folder: "INBOX", uid: 7, isDraft: false, subject: "Frozen", plainText: "body", from: [{ address: "a@x.com" }] }).id;
  });

  test("it can be disabled and re-enabled in the account settings, and the API says so", async () => {
    const off = await api("PATCH", acc, { token, body: { disabled: true } });
    expect(off.status).toBe(200);
    expect(off.json.disabled).toBe(true);
    expect((await api("GET", "/api/accounts", { token })).json[0].disabled).toBe(true);
  });

  test("it stays readable: lists, messages and its folders (from the stored mail, without contacting the server)", async () => {
    expect((await api("GET", `${acc}/emails?folder=INBOX`, { token })).json.map((e: { subject: string }) => e.subject)).toEqual(["Frozen"]);
    expect((await api("GET", `${acc}/emails/${emailId}`, { token })).json.subject).toBe("Frozen");
    const folders = await api("GET", `${acc}/folders`, { token });
    expect(folders.status).toBe(200); // the IMAP host is unreachable: a live listing would have failed
    expect(folders.json.map((f: { path: string; total: number }) => [f.path, f.total])).toEqual([["INBOX", 1]]);
    expect((await api("GET", "/api/search?q=frozen", { token })).json).toHaveLength(1);
  });

  test("everything that would change it, or connect to its servers, is refused with 409 — and nothing changes", async () => {
    const before = JSON.stringify(getEmail(db, emailId));
    const refused: [string, string, unknown?][] = [
      ["POST", `${acc}/emails`, { subject: "new draft" }],
      ["PATCH", `${acc}/emails/${emailId}`, { isRead: true }],
      ["PATCH", `${acc}/emails/${emailId}`, { isFlagged: true }],
      ["DELETE", `${acc}/emails/${emailId}`],
      ["PATCH", `${acc}/emails/${emailId}/move/Archive`],
      ["PATCH", `${acc}/emails/bulk`, { ids: [emailId], isRead: true }],
      ["DELETE", `${acc}/emails/bulk`, { ids: [emailId] }],
      ["PATCH", `${acc}/emails/bulk/move/Archive`, { ids: [emailId] }],
      ["POST", `${acc}/emails/${emailId}/send`],
      ["DELETE", `${acc}/emails/${emailId}/attachments/1`],
      ["POST", `${acc}/downloads`, {}],
      ["POST", `${acc}/imap-capabilities`],
      ["POST", `${acc}/emails/${emailId}/ai/summarize`],
      ["POST", `${acc}/emails/${emailId}/ai/translate`, { language: "German" }],
      ["POST", `${acc}/emails/${emailId}/ai/categorize`],
    ];
    for (const [method, path, body] of refused) {
      const res = await api(method, path, { token, body });
      expect([method, path, res.status]).toEqual([method, path, 409]);
      expect(res.json.error).toContain("disabled");
    }
    expect(JSON.stringify(getEmail(db, emailId))).toBe(before);
    expect(db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM emails WHERE account_id = ?").get(accountId)!.n).toBe(1); // no draft was created
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM downloads").get()!.n).toBe(0); // no sync job either
  });

  test("re-enabling makes it writable again", async () => {
    expect((await api("PATCH", acc, { token, body: { disabled: false } })).json.disabled).toBe(false);
    const draft = await api("POST", `${acc}/emails`, { token, body: { subject: "new draft" } });
    expect(draft.status).toBe(201);
  });

  test("a disabled account can still be removed", async () => {
    await api("PATCH", acc, { token, body: { disabled: true } });
    expect((await api("DELETE", acc, { token })).status).toBe(204);
  });
});
