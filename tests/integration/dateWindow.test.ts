import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { createEmail } from "../../src/server/models/emails";

const configDir = mkdtempSync(join(tmpdir(), "psmail-window-test-"));
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
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

describe("date windows over HTTP (after inclusive, before exclusive)", () => {
  let token = "";
  const list = (query: string) => call("GET", `/api/accounts/win%40example.com/emails?folder=INBOX&${query}`, { token });

  test("set up: a folder with messages on several days", async () => {
    await call("POST", "/api/users", { body: { username: "wes", password: "pw" } });
    token = (await call("POST", "/api/auth/login", { body: { username: "wes", password: "pw" } })).json.token;
    const acc = await call("POST", "/api/accounts", {
      token,
      body: { email: "win@example.com", imapHost: "h", imapPort: 993, imapUsername: "u", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "y" },
    });
    for (const [subject, date] of [["mar 1", "2026-03-01T23:00:00Z"], ["mar 2", "2026-03-02T09:00:00Z"], ["mar 3", "2026-03-03T00:00:00Z"]] as const) {
      createEmail(db, acc.json.id, { folder: "INBOX", isDraft: false, subject, date: new Date(date).toISOString(), from: [{ address: "s@y.com" }] });
    }
  });

  test("the folder list and the combined Inbox honor after and before", async () => {
    const window = "after=2026-03-02T00:00:00.000Z&before=2026-03-03T00:00:00.000Z";
    expect((await list(window)).json.map((e: { subject: string }) => e.subject)).toEqual(["mar 2"]);
    expect((await list("after=2026-03-02T00:00:00.000Z")).json.map((e: { subject: string }) => e.subject)).toEqual(["mar 3", "mar 2"]);
    expect((await list("before=2026-03-02T00:00:00.000Z")).json.map((e: { subject: string }) => e.subject)).toEqual(["mar 1"]);
    expect((await call("GET", `/api/unified/inbox?${window}`, { token })).json.map((e: { subject: string }) => e.subject)).toEqual(["mar 2"]);
  });

  test("search takes the window too", async () => {
    const found = async (query: string) => (await call("GET", `/api/search?q=mar&${query}`, { token })).json.map((e: { subject: string }) => e.subject);
    expect(await found("")).toEqual(["mar 3", "mar 2", "mar 1"]);
    expect(await found("after=2026-03-02T00:00:00.000Z&before=2026-03-03T00:00:00.000Z")).toEqual(["mar 2"]);
    expect((await call("GET", "/api/search?q=mar&after=nope", { token })).status).toBe(400);
  });

  test("fulltext=1 turns on the text search (the flag comes from the client's option)", async () => {
    const subjects = async (query: string) => (await call("GET", `/api/search?${query}`, { token })).json.map((e: { subject: string }) => e.subject);
    expect(await subjects("q=mar&fulltext=1")).toEqual(["mar 3", "mar 2", "mar 1"]);
    expect(await subjects("q=zzzz&fulltext=1")).toEqual([]);
  });

  test("a bad window is a 400 with the reason, not an empty list", async () => {
    for (const query of ["after=yesterday", "before=nope", "after=2026-03-03T00:00:00Z&before=2026-03-02T00:00:00Z"]) {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/date|earlier/);
    }
    expect((await call("GET", "/api/unified/inbox?after=garbage", { token })).status).toBe(400);
  });
});
