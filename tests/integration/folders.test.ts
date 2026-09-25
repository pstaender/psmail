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
  return {
    status: res.status,
    json: text ? JSON.parse(text) : undefined,
    source: res.headers.get("x-folders-source"),
    warning: res.headers.get("x-folders-warning") ? decodeURIComponent(res.headers.get("x-folders-warning")!) : null,
  };
}
async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function patch(path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
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

  test("?live=1 talks to the server; when it can't be reached the cached folders are still listed, with the reason", async () => {
    const res = await get(`${acc}?live=1`, token);
    expect(res.status).toBe(200);
    expect(res.source).toBe("local");
    expect(res.warning).toContain("Couldn't read the folders of slow@example.com from 127.0.0.1");
    expect(res.json.map((f: { path: string; total: number }) => [f.path, f.total])).toEqual([["INBOX", 2], ["Sent", 0]]); // the stored structure and counts
    expect((await get(acc, token)).source).toBe("cache"); // and a plain request still works from the cache
  });
});

describe("folder list when the server can't be reached and nothing is cached", () => {
  test("the folders that hold stored mail are listed anyway, so downloaded mail stays readable", async () => {
    await post("/api/users", { username: "gil", password: "pw" });
    const token = (await post("/api/auth/login", { username: "gil", password: "pw" })).json.token;
    const created = await post(
      "/api/accounts",
      { email: "down@example.com", imapHost: "127.0.0.1", imapPort: 1, imapUsername: "u", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "y" },
      token
    );
    const path = `/api/accounts/${encodeURIComponent("down@example.com")}/folders`;

    // Nothing stored either: an error with the reason is all there is to show.
    expect((await get(path, token)).status).toBe(502);

    createEmail(db, created.json.id, { folder: "INBOX", uid: 1, isDraft: false, isRead: false, subject: "kept" });
    createEmail(db, created.json.id, { folder: "Archive/2024", uid: 1, isDraft: false, isRead: true, subject: "old" });
    createEmail(db, created.json.id, { folder: "Sent", uid: 1, isDraft: false, isRead: true, subject: "out" });

    const res = await get(path, token);
    expect(res.status).toBe(200);
    expect(res.source).toBe("local");
    expect(res.warning).toContain("down@example.com");
    const byPath = Object.fromEntries(res.json.map((f: { path: string; total: number; unread: number; specialUse: string | null }) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["Archive/2024", "INBOX", "Sent"]);
    expect(byPath["INBOX"]).toMatchObject({ total: 1, unread: 1 });
    expect(byPath["Sent"].specialUse).toBe("\\Sent"); // guessed from the name, for a sensible icon
  });
});

describe("creating a folder (POST /api/accounts/:email/folders)", () => {
  const newAccount = (email: string, extra: Record<string, unknown> = {}) => ({
    email, imapHost: "127.0.0.1", imapPort: 1, imapUsername: "u", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "y", ...extra,
  });
  let token = "";
  const path = (email: string) => `/api/accounts/${encodeURIComponent(email)}/folders`;

  test("set up", async () => {
    await post("/api/users", { username: "hal", password: "pw" });
    token = (await post("/api/auth/login", { username: "hal", password: "pw" })).json.token;
  });

  test("a read-only account can't get a folder — that would be a change on its server", async () => {
    await post("/api/accounts", newAccount("ro@example.com", { readOnly: true }), token);
    const res = await post(path("ro@example.com"), { name: "Receipts" }, token);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("read-only");
  });

  test("a disabled account can't either", async () => {
    await post("/api/accounts", newAccount("off@example.com"), token);
    await fetch(`${base}/api/accounts/${encodeURIComponent("off@example.com")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ disabled: true }),
    });
    const res = await post(path("off@example.com"), { name: "Receipts" }, token);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("disabled");
  });

  test("a missing name is a 400", async () => {
    await post("/api/accounts", newAccount("ok@example.com"), token);
    expect((await post(path("ok@example.com"), {}, token)).status).toBe(400);
  });

  test("when the server can't be reached that is said, and nothing is cached", async () => {
    const res = await post(path("ok@example.com"), { name: "Receipts" }, token);
    expect(res.status).toBe(502);
    expect(res.json.error).toContain("Couldn't create the folder on 127.0.0.1");
  });

  test("another user's account is not found", async () => {
    await post("/api/users", { username: "ivy", password: "pw" });
    const other = (await post("/api/auth/login", { username: "ivy", password: "pw" })).json.token;
    expect((await post(path("ok@example.com"), { name: "x" }, other)).status).toBe(404);
  });
});

describe("renaming a folder (PATCH /api/accounts/:email/folders/:folder)", () => {
  const newAccount = (email: string, extra: Record<string, unknown> = {}) => ({
    email, imapHost: "127.0.0.1", imapPort: 1, imapUsername: "u", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "y", ...extra,
  });
  let token = "";
  const path = (email: string, folder: string) => `/api/accounts/${encodeURIComponent(email)}/folders/${encodeURIComponent(folder)}`;

  test("set up", async () => {
    await post("/api/users", { username: "kim", password: "pw" });
    token = (await post("/api/auth/login", { username: "kim", password: "pw" })).json.token;
  });

  test("a read-only account can't rename a folder — that would be a change on its server", async () => {
    await post("/api/accounts", newAccount("ro2@example.com", { readOnly: true }), token);
    const res = await patch(path("ro2@example.com", "Work"), { name: "Projects" }, token);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("read-only");
  });

  test("a disabled account can't either", async () => {
    await post("/api/accounts", newAccount("off2@example.com"), token);
    await fetch(`${base}/api/accounts/${encodeURIComponent("off2@example.com")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ disabled: true }),
    });
    const res = await patch(path("off2@example.com", "Work"), { name: "Projects" }, token);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("disabled");
  });

  test("a missing new name is a 400", async () => {
    await post("/api/accounts", newAccount("ok2@example.com"), token);
    expect((await patch(path("ok2@example.com", "Work"), {}, token)).status).toBe(400);
  });

  test("when the server can't be reached that is said, and nothing is renamed locally", async () => {
    const res = await patch(path("ok2@example.com", "Work"), { name: "Projects" }, token);
    expect(res.status).toBe(502);
    expect(res.json.error).toContain("Couldn't rename the folder on 127.0.0.1");
  });

  test("another user's account is not found", async () => {
    const other = (await post("/api/auth/login", { username: "ivy", password: "pw" })).json.token;
    expect((await patch(path("ok2@example.com", "Work"), { name: "x" }, other)).status).toBe(404);
  });
});

describe("GET .../folders/:folder/find-message-id (diagnostic)", () => {
  let token: string;
  const path = (folder: string, id: string) => `/api/accounts/${encodeURIComponent("slow@example.com")}/folders/${encodeURIComponent(folder)}/find-message-id?id=${encodeURIComponent(id)}`;

  test("set up: reuse the unreachable account from above", async () => {
    token = (await post("/api/auth/login", { username: "fay", password: "pw" })).json.token;
  });

  test("a missing id is a 400", async () => {
    const res = await get(`/api/accounts/${encodeURIComponent("slow@example.com")}/folders/Sent/find-message-id`, token);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/id/i);
  });

  test("needs a login, like everything else", async () => {
    const res = await fetch(`${base}${path("Sent", "<a@b>")}`);
    expect(res.status).toBe(401);
  });

  test("an unreachable server is a 502 naming what was being searched, not a hang or a 500", async () => {
    const res = await get(path("Sent", "<a@b.example>"), token);
    expect(res.status).toBe(502);
    expect(res.json.error).toContain('Couldn\'t search "Sent"');
    expect(res.json.error).toContain("127.0.0.1");
  });

  test("another user's account is not found", async () => {
    const other = (await post("/api/auth/login", { username: "ivy", password: "pw" })).json.token;
    expect((await get(path("Sent", "<a@b>"), other)).status).toBe(404);
  });
});
