import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { decryptSecret, deriveEncryptionKey } from "../../src/server/crypto/secrets";
import { getAccountByEmail } from "../../src/server/models/accounts";

const configDir = mkdtempSync(join(tmpdir(), "psmail-pw-test-"));
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

describe("changing the password", () => {
  test("re-encrypts the account passwords, keeps this session working, and signs out the other sessions", async () => {
    const created = await api("POST", "/api/users", { body: { username: "pat", password: "old-pw" } });
    const login = async (password: string) => api("POST", "/api/auth/login", { body: { username: "pat", password } });

    const a = (await login("old-pw")).json.token as string;
    const b = (await login("old-pw")).json.token as string; // e.g. another browser
    const email = "me@example.com";
    const account = await api("POST", "/api/accounts", {
      token: a,
      body: {
        email, imapHost: "h", imapPort: 993, imapUsername: email, imapPassword: "imap-secret",
        smtpHost: "h", smtpPort: 465, smtpUsername: email, smtpPassword: "smtp-secret",
      },
    });
    expect(account.status).toBe(201);

    // Validation and the current-password check come first, and change nothing.
    expect((await api("POST", "/api/auth/change-password", { token: a, body: { newPassword: "x" } })).status).toBe(400);
    expect((await api("POST", "/api/auth/change-password", { body: { currentPassword: "old-pw", newPassword: "x" } })).status).toBe(401);
    const wrong = await api("POST", "/api/auth/change-password", { token: a, body: { currentPassword: "nope", newPassword: "new-pw" } });
    expect(wrong.status).toBe(401);
    expect((await login("old-pw")).status).toBe(200);

    const changed = await api("POST", "/api/auth/change-password", { token: a, body: { currentPassword: "old-pw", newPassword: "new-pw" } });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ ok: true, otherSessionsSignedOut: expect.any(Number) });

    // The other session is gone (its key was stale); this one still works, including its access to decrypted secrets.
    expect((await api("GET", "/api/accounts", { token: b })).status).toBe(401);
    expect((await api("GET", "/api/accounts", { token: a })).status).toBe(200);

    // Old password no longer logs in, the new one does…
    expect((await login("old-pw")).status).toBe(401);
    const fresh = await login("new-pw");
    expect(fresh.status).toBe(200);

    // …and the stored account secrets open with the key derived from the new password and salt.
    const salt = db.query<{ password_salt: string }, [number]>("SELECT password_salt FROM users WHERE id = ?").get(created.json.id)!.password_salt;
    const row = getAccountByEmail(db, created.json.id, email);
    const key = deriveEncryptionKey("new-pw", salt);
    expect(decryptSecret(row.imap_password_encrypted, key)).toBe("imap-secret");
    expect(decryptSecret(row.smtp_password_encrypted, key)).toBe("smtp-secret");
  });

  test("PATCH /api/users/:id needs the current password too, because it changes the encryption key", async () => {
    const created = await api("POST", "/api/users", { body: { username: "quinn", password: "old-pw" } });
    const token = (await api("POST", "/api/auth/login", { body: { username: "quinn", password: "old-pw" } })).json.token as string;

    expect((await api("PATCH", `/api/users/${created.json.id}`, { token, body: { password: "new-pw" } })).status).toBe(400);
    expect((await api("PATCH", `/api/users/${created.json.id}`, { token, body: { password: "new-pw", currentPassword: "old-pw" } })).status).toBe(200);
    expect((await api("POST", "/api/auth/login", { body: { username: "quinn", password: "new-pw" } })).status).toBe(200);
  });
});
