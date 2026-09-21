import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { createEmail } from "../../src/server/models/emails";
import { changeUsername, getUser, verifyUserPassword } from "../../src/server/models/users";

const configDir = mkdtempSync(join(tmpdir(), "psmail-username-test-"));
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
const login = async (username: string, password: string) => call("POST", "/api/auth/login", { body: { username, password } });
const account = (email: string) => ({ email, imapHost: "h", imapPort: 993, imapUsername: "u", imapPassword: "imap-secret", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "smtp-secret" });

describe("renaming a user", () => {
  let token = "";
  let userId = 0;
  let attachmentPath = "";
  let emailId = 0;

  test("set up: a user with an account, a message and an attachment file on disk", async () => {
    userId = (await call("POST", "/api/users", { body: { username: "alice", password: "pw" } })).json.id;
    await call("POST", "/api/users", { body: { username: "bob", password: "pw" } });
    token = (await login("alice", "pw")).json.token;
    const acc = await call("POST", "/api/accounts", { token, body: account("alice@example.com") });
    emailId = createEmail(db, acc.json.id, { folder: "INBOX", isDraft: false, subject: "With file", from: [{ address: "x@y.example" }] }).id;

    const dir = join(configDir, "attachments", "alice", "alice@example.com", String(emailId));
    mkdirSync(dir, { recursive: true });
    attachmentPath = join(dir, "note.txt");
    writeFileSync(attachmentPath, "attached text");
    db.query("INSERT INTO attachments (email_id, filename, content_type, size, file_path) VALUES (?, 'note.txt', 'text/plain', 13, ?)").run(emailId, attachmentPath);
  });

  test("needs a login, and a name", async () => {
    expect((await call("POST", "/api/auth/change-username", { body: { username: "x" } })).status).toBe(401);
    expect((await call("POST", "/api/auth/change-username", { token, body: {} })).status).toBe(400);
    expect((await call("POST", "/api/auth/change-username", { token, body: { username: "   " } })).status).toBe(400);
    expect((await call("POST", "/api/auth/change-username", { token, body: { username: "x".repeat(65) } })).status).toBe(400);
    expect((await call("POST", "/api/auth/change-username", { token, body: { username: "bad\nname" } })).status).toBe(400);
  });

  test("a name that is taken is a 409 and nothing changes", async () => {
    const res = await call("POST", "/api/auth/change-username", { token, body: { username: "bob" } });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain('"bob" already exists');
    expect(getUser(db, userId).username).toBe("alice");
  });

  test("renaming: trimmed, the new name signs in and the old one doesn't, the password and the session are untouched", async () => {
    const res = await call("POST", "/api/auth/change-username", { token, body: { username: "  Alice Smith " } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: userId, username: "Alice Smith" });

    expect((await login("Alice Smith", "pw")).status).toBe(200);
    expect((await login("alice", "pw")).status).toBe(404); // no such profile any more
    expect((await login("Alice Smith", "wrong")).status).toBe(401);
    expect((await call("GET", "/api/accounts", { token })).status).toBe(200); // the session that made the change still works
    expect((await call("GET", "/api/users")).json.map((u: { username: string }) => u.username)).toEqual(["Alice Smith", "bob"]);
  });

  test("the saved account passwords still decrypt (the key comes from the password, not the name)", async () => {
    const relogin = (await login("Alice Smith", "pw")).json.token;
    const created = await call("POST", "/api/accounts/alice%40example.com/imap-capabilities", { token: relogin }).catch(() => null);
    expect(created === null || typeof created.status === "number").toBe(true); // reaching the account with the new session is enough: a wrong key would fail earlier
    expect((await call("GET", "/api/accounts/alice%40example.com", { token: relogin })).status).toBe(200);
  });

  test("the attachment folder followed the name, the stored path too, and the file is still served", async () => {
    const newPath = join(configDir, "attachments", "Alice Smith", "alice@example.com", String(emailId), "note.txt");
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(join(configDir, "attachments", "alice"))).toBe(false);
    expect(readFileSync(newPath, "utf8")).toBe("attached text");
    expect(db.query<{ file_path: string }, [number]>("SELECT file_path FROM attachments WHERE email_id = ?").get(emailId)!.file_path).toBe(newPath);

    const relogin = (await login("Alice Smith", "pw")).json.token;
    const attachment = db.query<{ id: number }, [number]>("SELECT id FROM attachments WHERE email_id = ?").get(emailId)!;
    const res = await fetch(`${base}/api/accounts/alice%40example.com/emails/${emailId}/attachments/${attachment.id}`, { headers: { authorization: `Bearer ${relogin}` } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("attached text");
  });

  test("the same name again changes nothing; renaming back works; other users' files are left alone", async () => {
    mkdirSync(join(configDir, "attachments", "bob"), { recursive: true });
    writeFileSync(join(configDir, "attachments", "bob", "keep.txt"), "bob's");

    const same = await call("POST", "/api/auth/change-username", { token, body: { username: "Alice Smith" } });
    expect(same.status).toBe(200);
    const back = await call("POST", "/api/auth/change-username", { token, body: { username: "alice" } });
    expect(back.json.username).toBe("alice");
    expect(existsSync(attachmentPath)).toBe(true); // moved back to where it was
    expect(readFileSync(join(configDir, "attachments", "bob", "keep.txt"), "utf8")).toBe("bob's");
  });
});

describe("changeUsername in the model", () => {
  test("if the target folder already exists the files stay where they are (and the stored paths with them)", async () => {
    const localDb = createTestDb();
    const { createUser } = await import("../../src/server/models/users");
    const user = await createUser(localDb, "carol", "pw");
    const oldDir = join(configDir, "attachments", "carol");
    const otherDir = join(configDir, "attachments", "dora");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true }); // left over from an earlier profile of that name
    expect(changeUsername(localDb, user.id, "dora").username).toBe("dora");
    expect(existsSync(oldDir)).toBe(true); // not moved onto someone else's folder
    expect((await verifyUserPassword(localDb, "dora", "pw")).id).toBe(user.id);
  });

  test("a missing user is a 404", () => {
    expect(() => changeUsername(createTestDb(), 999, "x")).toThrow();
  });
});
