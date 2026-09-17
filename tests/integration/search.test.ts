import { afterAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";

const db = createTestDb();
const server = startTestServer(db);
const base = server.url.toString().replace(/\/$/, "");

afterAll(() => {
  server.stop(true);
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

describe("GET /api/search", () => {
  let token: string;
  const accountEmail = "me@example.com";

  test("setup: user, account, and a couple of emails across folders", async () => {
    await api("POST", "/api/users", { body: { username: "searchuser", password: "pw" } });
    const login = await api("POST", "/api/auth/login", { body: { username: "searchuser", password: "pw" } });
    token = login.json.token;

    const account = await api("POST", "/api/accounts", {
      token,
      body: {
        email: accountEmail,
        imapHost: "imap.example.com",
        imapPort: 993,
        imapUsername: accountEmail,
        imapPassword: "x",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpUsername: accountEmail,
        smtpPassword: "x",
      },
    });
    expect(account.status).toBe(201);

    const draft1 = await api("POST", `/api/accounts/${encodeURIComponent(accountEmail)}/emails`, {
      token,
      body: { subject: "Amazon Gutschein Angebot", from: [{ address: "no-reply@amazon.de" }] },
    });
    expect(draft1.status).toBe(201);

    const draft2 = await api("POST", `/api/accounts/${encodeURIComponent(accountEmail)}/emails`, {
      token,
      body: { subject: "Team meeting notes", from: [{ address: "colleague@example.com" }] },
    });
    expect(draft2.status).toBe(201);
  });

  test("rejects unauthenticated requests", async () => {
    const { status } = await api("GET", "/api/search?q=amazon");
    expect(status).toBe(401);
  });

  test("finds a matching subject, case-insensitively, with a wildcard", async () => {
    const { status, json } = await api("GET", "/api/search?q=" + encodeURIComponent("amazon*angebot"), { token });
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].subject).toBe("Amazon Gutschein Angebot");
    expect(json[0].accountEmail).toBe(accountEmail);
  });

  test("returns nothing for a non-matching query", async () => {
    const { json } = await api("GET", "/api/search?q=nonexistent", { token });
    expect(json).toEqual([]);
  });

  test("combines from: with a subject term", async () => {
    const { json } = await api(
      "GET",
      "/api/search?q=" + encodeURIComponent("from:colleague@example.com meeting"),
      { token }
    );
    expect(json).toHaveLength(1);
    expect(json[0].subject).toBe("Team meeting notes");
  });
});
