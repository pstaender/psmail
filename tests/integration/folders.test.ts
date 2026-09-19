import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { createEmail } from "../../src/server/models/emails";
import { getFoldersCache, setFoldersCache } from "../../src/server/models/accounts";

const configDir = mkdtempSync(join(tmpdir(), "psmail-folders-test-"));
process.env.PSMAIL_CONFIG_DIR = configDir;

const db = createTestDb();
const server = startTestServer(db);
const base = server.url.toString().replace(/\/$/, "");

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

async function get(path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, source: res.headers.get("x-folders-source") };
}
async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("folder list", () => {
  let token: string;
  let accountId: number;
  const acc = `/api/accounts/${encodeURIComponent("slow@example.com")}/folders`;
  const cached = [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", flags: [] },
    { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent", flags: [] },
  ];

  test("set up: an account whose IMAP server can't be reached", async () => {
    await post("/api/users", { username: "fay", password: "pw" });
    token = (await post("/api/auth/login", { username: "fay", password: "pw" })).json.token;
    const created = await post(
      "/api/accounts",
      { email: "slow@example.com", imapHost: "127.0.0.1", imapPort: 1, imapUsername: "u", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "y" },
      token
    );
    accountId = created.json.id;
  });

  test("with no cache yet, the listing has to go live — and a failure is an error with the reason, not a hang", async () => {
    const res = await get(acc, token);
    expect(res.status).toBe(502);
    expect(res.json.error).toContain("Couldn't read the folders of slow@example.com from 127.0.0.1");
    expect(getFoldersCache(db, accountId)).toBeNull(); // a failure caches nothing
  });

  test("with a cached listing a plain request is answered from it, without touching IMAP, and counts are fresh", async () => {
    setFoldersCache(db, accountId, cached);
    createEmail(db, accountId, { folder: "INBOX", uid: 1, isDraft: false, isRead: false, subject: "a" });

    const first = await get(acc, token);
    expect(first.status).toBe(200);
    expect(first.source).toBe("cache");
    expect(first.json.map((f: { path: string; total: number; unread: number }) => [f.path, f.total, f.unread])).toEqual([["INBOX", 1, 1], ["Sent", 0, 0]]);

    createEmail(db, accountId, { folder: "INBOX", uid: 2, isDraft: false, isRead: true, subject: "b" });
    expect((await get(acc, token)).json[0]).toMatchObject({ total: 2, unread: 1 }); // counts come from the database every time
  });

  test("?live=1 talks to the server (here: fails with the reason) and leaves the cache alone", async () => {
    const res = await get(`${acc}?live=1`, token);
    expect(res.status).toBe(502);
    expect(res.json.error).toContain("slow@example.com");
    expect((await get(acc, token)).source).toBe("cache"); // still usable afterwards
  });
});
