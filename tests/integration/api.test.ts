import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";

// Isolate attachment storage from the user's real config dir.
const configDir = mkdtempSync(join(tmpdir(), "psmail-test-"));
process.env.PSMAIL_CONFIG_DIR = configDir;

const db = createTestDb();
const server = startTestServer(db);
const base = server.url.toString().replace(/\/$/, "");

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

async function api(method: string, path: string, opts: { token?: string; body?: unknown; formData?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, res };
}

describe("P.S.Mail API", () => {
  let token: string;
  let userId: number;
  const accountEmail = "me@example.com";

  test("POST /api/users creates a user", async () => {
    const { status, json } = await api("POST", "/api/users", { body: { username: "alice", password: "s3cret" } });
    expect(status).toBe(201);
    expect(json.username).toBe("alice");
    userId = json.id;
  });

  test("POST /api/users rejects duplicate usernames", async () => {
    const { status } = await api("POST", "/api/users", { body: { username: "alice", password: "other" } });
    expect(status).toBe(409);
  });

  test("GET /api/users lists usernames without secrets", async () => {
    const { status, json } = await api("GET", "/api/users");
    expect(status).toBe(200);
    expect(json.some((u: { username: string }) => u.username === "alice")).toBe(true);
    expect(json[0].password_hash).toBeUndefined();
  });

  test("POST /api/auth/login rejects wrong password", async () => {
    const { status } = await api("POST", "/api/auth/login", { body: { username: "alice", password: "wrong" } });
    expect(status).toBe(401);
  });

  test("POST /api/auth/login succeeds and returns a session token", async () => {
    const { status, json } = await api("POST", "/api/auth/login", { body: { username: "alice", password: "s3cret" } });
    expect(status).toBe(200);
    expect(typeof json.token).toBe("string");
    token = json.token;
  });

  test("protected routes reject requests without a token", async () => {
    const { status } = await api("GET", "/api/accounts");
    expect(status).toBe(401);
  });

  test("PATCH /api/users/:id rejects modifying another user", async () => {
    const { status } = await api("PATCH", `/api/users/${userId + 999}`, {
      token,
      body: { password: "x" },
    });
    expect(status).toBe(403);
  });

  test("POST /api/accounts creates an email account with encrypted credentials", async () => {
    const { status, json } = await api("POST", "/api/accounts", {
      token,
      body: {
        email: accountEmail,
        imapHost: "imap.example.com",
        imapPort: 993,
        imapUsername: accountEmail,
        imapPassword: "imap-secret",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpUsername: accountEmail,
        smtpPassword: "smtp-secret",
      },
    });
    expect(status).toBe(201);
    expect(json.email).toBe(accountEmail);
    expect(json.imapPassword).toBeUndefined();
  });

  test("GET /api/accounts lists only the caller's accounts", async () => {
    const { status, json } = await api("GET", "/api/accounts", { token });
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].email).toBe(accountEmail);
  });

  test("GET /api/accounts/:email/emails starts empty", async () => {
    const { status, json } = await api("GET", `/api/accounts/${encodeURIComponent(accountEmail)}/emails`, { token });
    expect(status).toBe(200);
    expect(json).toEqual([]);
  });

  let draftId: number;

  test("POST /api/accounts/:email/emails creates a draft", async () => {
    const { status, json } = await api("POST", `/api/accounts/${encodeURIComponent(accountEmail)}/emails`, {
      token,
      body: { subject: "Draft subject", to: [{ address: "friend@example.com" }] },
    });
    expect(status).toBe(201);
    expect(json.isDraft).toBe(true);
    expect(json.folder).toBe("Drafts");
    draftId = json.id;
  });

  test("GET .../emails/:id fetches the draft", async () => {
    const { status, json } = await api("GET", `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${draftId}`, {
      token,
    });
    expect(status).toBe(200);
    expect(json.subject).toBe("Draft subject");
  });

  test("PATCH .../emails/:id updates fields", async () => {
    const { status, json } = await api("PATCH", `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${draftId}`, {
      token,
      body: { subject: "Updated subject" },
    });
    expect(status).toBe(200);
    expect(json.subject).toBe("Updated subject");
  });

  test("PATCH .../move/:folder moves the email", async () => {
    const { status, json } = await api(
      "PATCH",
      `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${draftId}/move/Archive`,
      { token }
    );
    expect(status).toBe(200);
    expect(json.folder).toBe("Archive");
  });

  test("POST .../send rejects a draft with no From address", async () => {
    const { status, json } = await api(
      "POST",
      `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${draftId}/send`,
      { token }
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/From address/);
  });

  test("attachments: upload, download, and delete", async () => {
    const form = new FormData();
    form.append("file", new File(["hello world"], "note.txt", { type: "text/plain" }));

    const upload = await api(
      "POST",
      `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${draftId}/attachments`,
      { token, formData: form }
    );
    expect(upload.status).toBe(201);
    expect(upload.json.filename).toBe("note.txt");
    const attachmentId = upload.json.id;

    const download = await api(
      "GET",
      `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${draftId}/attachments/${attachmentId}`,
      { token }
    );
    expect(download.status).toBe(200);
    expect(download.text).toBe("hello world");

    const del = await api(
      "DELETE",
      `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${draftId}/attachments/${attachmentId}`,
      { token }
    );
    expect(del.status).toBe(204);
  });

  test("DELETE .../emails/:id removes the draft", async () => {
    const { status } = await api("DELETE", `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${draftId}`, {
      token,
    });
    expect(status).toBe(204);

    const { status: getStatus } = await api(
      "GET",
      `/api/accounts/${encodeURIComponent(accountEmail)}/emails/${draftId}`,
      { token }
    );
    expect(getStatus).toBe(404);
  });

  test("accounts owned by other users are not accessible (404, not 403, to avoid leaking existence)", async () => {
    await api("POST", "/api/users", { body: { username: "bob", password: "pw" } });
    const login = await api("POST", "/api/auth/login", { body: { username: "bob", password: "pw" } });
    const bobToken = login.json.token;

    const { status } = await api("GET", `/api/accounts/${encodeURIComponent(accountEmail)}`, { token: bobToken });
    expect(status).toBe(404);
  });

  test("DELETE /api/accounts/:email removes the account", async () => {
    const { status } = await api("DELETE", `/api/accounts/${encodeURIComponent(accountEmail)}`, { token });
    expect(status).toBe(204);
  });
});
