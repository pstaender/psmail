import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { createEmail } from "../../src/server/models/emails";

const configDir = mkdtempSync(join(tmpdir(), "psmail-conv-test-"));
process.env.PSMAIL_CONFIG_DIR = configDir;
const db = createTestDb();
const server = startTestServer(db);
const base = server.url.toString().replace(/\/$/, "");
afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

describe("conversations over HTTP", () => {
  let token = "";
  let questionId = 0;
  let answerId = 0;
  let aloneId = 0;
  const conv = (id: number, email = "me@example.com") => `/api/accounts/${encodeURIComponent(email)}/emails/${id}/conversation`;

  test("set up: a question, my answer, and a message on its own", async () => {
    await call("POST", "/api/users", { body: { username: "conv", password: "pw" } });
    token = (await call("POST", "/api/auth/login", { body: { username: "conv", password: "pw" } })).json.token;
    const acc = await call("POST", "/api/accounts", { token, body: { email: "me@example.com", imapHost: "h", imapPort: 993, imapUsername: "u", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "y" } });
    const make = (over: Record<string, unknown>) => createEmail(db, acc.json.id, { isDraft: false, plainText: "Hallo", to: [{ address: "me@example.com" }], ...over }).id;
    questionId = make({ folder: "INBOX", from: [{ name: "Anna", address: "anna@x.example" }], subject: "Frage", messageId: "<q@x>", date: "2026-06-01T10:00:00Z" });
    answerId = make({ folder: "Sent", from: [{ address: "me@example.com" }], subject: "Re: Frage", messageId: "<a@me>", inReplyTo: "<q@x>", date: "2026-06-02T10:00:00Z", plainText: "Antwort" });
    aloneId = make({ folder: "INBOX", from: [{ address: "bob@x.example" }], subject: "Ruhig", messageId: "<b@x>", date: "2026-06-03T10:00:00Z" });
  });

  test("GET .../conversation: the messages oldest first and the answer to open", async () => {
    const res = await call("GET", conv(questionId), { token });
    expect(res.status).toBe(200);
    expect(res.json.messages.map((m: { id: number }) => m.id)).toEqual([questionId, answerId]);
    expect(res.json.messages.map((m: { own: boolean }) => m.own)).toEqual([false, true]);
    expect(res.json.messages[0]).toMatchObject({ current: true, folder: "INBOX", accountEmail: "me@example.com", subject: "Frage" });
    expect(res.json.repliedBy).toBe(answerId);
    expect((await call("GET", conv(aloneId), { token })).json).toMatchObject({ repliedBy: null, messages: [{ id: aloneId }] });
  });

  test("the folder list marks the answered message and its answer, and leaves the quiet one alone", async () => {
    const inbox = (await call("GET", "/api/accounts/me%40example.com/emails?folder=INBOX", { token })).json;
    expect(inbox.find((e: { id: number }) => e.id === questionId).conversation).toEqual({ replied: true, related: 1 });
    expect(inbox.find((e: { id: number }) => e.id === aloneId)).not.toHaveProperty("conversation");
    const sent = (await call("GET", "/api/accounts/me%40example.com/emails?folder=Sent", { token })).json;
    expect(sent[0].conversation).toEqual({ replied: false, related: 1 });
  });

  test("the combined lists and the search carry it too", async () => {
    const unified = (await call("GET", "/api/unified/inbox", { token })).json;
    expect(unified.find((r: { id: number }) => r.id === questionId).conversation).toEqual({ replied: true, related: 1 });
    const found = (await call("GET", "/api/search?q=Frage", { token })).json;
    expect(found.find((r: { id: number }) => r.id === questionId).conversation.replied).toBe(true);
  });

  test("refused: no login, another account's message, an unknown message; and the other user sees nothing", async () => {
    expect((await call("GET", conv(questionId))).status).toBe(401);
    expect((await call("GET", conv(9999), { token })).status).toBe(404);
    await call("POST", "/api/users", { body: { username: "other", password: "pw" } });
    const other = (await call("POST", "/api/auth/login", { body: { username: "other", password: "pw" } })).json.token;
    await call("POST", "/api/accounts", { token: other, body: { email: "them@example.com", imapHost: "h", imapPort: 993, imapUsername: "u", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "y" } });
    expect((await call("GET", conv(questionId, "them@example.com"), { token: other })).status).toBe(404);
  });
});
