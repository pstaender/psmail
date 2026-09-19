/**
 * Exercises the "push to IMAP" behavior added to mark-read/unread, delete, and move —
 * without mocking the IMAP module (see sync.test.ts's comment on why that's risky across
 * files) and without needing a real IMAP server: pointing an account at 127.0.0.1:1 (nothing
 * listens there) fails a real connection attempt in ~3ms with ECONNREFUSED, deterministically
 * standing in for "the IMAP push failed" so we can verify the local database is left
 * unchanged in that case. The happy path (a real server accepting the write) is covered by
 * the Greenmail-gated end-to-end test instead, since it needs the write to actually succeed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { listDeletedUids } from "../../src/server/models/tombstones";
import { createEmail, getEmail } from "../../src/server/models/emails";

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

const UNREACHABLE = { imapHost: "127.0.0.1", imapPort: 1, imapSecure: false };

describe("pushing email actions to IMAP", () => {
  let token: string;
  let liveAccountEmail: string;
  let readOnlyAccountEmail: string;

  test("setup: a normal account and a read-only one, both pointed at an unreachable IMAP host", async () => {
    await api("POST", "/api/users", { body: { username: "imapsync", password: "pw" } });
    const login = await api("POST", "/api/auth/login", { body: { username: "imapsync", password: "pw" } });
    token = login.json.token;

    liveAccountEmail = "live@example.com";
    readOnlyAccountEmail = "readonly@example.com";

    for (const [email, readOnly] of [[liveAccountEmail, false], [readOnlyAccountEmail, true]] as const) {
      const res = await api("POST", "/api/accounts", {
        token,
        body: {
          email,
          ...UNREACHABLE,
          imapUsername: email,
          imapPassword: "x",
          smtpHost: "smtp.example.com",
          smtpPort: 465,
          smtpUsername: email,
          smtpPassword: "x",
          readOnly,
        },
      });
      expect(res.status).toBe(201);
    }
  });

  test("a message with a real UID: PATCH isRead fails closed — local state stays unchanged", async () => {
    const account = await api("GET", `/api/accounts/${encodeURIComponent(liveAccountEmail)}`, { token });
    const email = createEmail(db, account.json.id, { folder: "INBOX", uid: 101, isDraft: false, isRead: false });

    const patch = await api("PATCH", `/api/accounts/${encodeURIComponent(liveAccountEmail)}/emails/${email.id}`, {
      token,
      body: { isRead: true },
    });
    expect(patch.status).toBeGreaterThanOrEqual(500);

    const stillLocal = getEmail(db, email.id);
    expect(stillLocal.isRead).toBe(false);
  });

  test("read-only account: PATCH isRead succeeds without ever attempting IMAP", async () => {
    const account = await api("GET", `/api/accounts/${encodeURIComponent(readOnlyAccountEmail)}`, { token });
    const email = createEmail(db, account.json.id, { folder: "INBOX", uid: 102, isDraft: false, isRead: false });

    const patch = await api("PATCH", `/api/accounts/${encodeURIComponent(readOnlyAccountEmail)}/emails/${email.id}`, {
      token,
      body: { isRead: true },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.isRead).toBe(true);
  });

  test("a draft (no UID) on a non-read-only account: PATCH isRead succeeds without attempting IMAP", async () => {
    const draft = await api("POST", `/api/accounts/${encodeURIComponent(liveAccountEmail)}/emails`, {
      token,
      body: { subject: "A draft" },
    });
    expect(draft.status).toBe(201);
    expect(draft.json.uid).toBeNull();

    const patch = await api("PATCH", `/api/accounts/${encodeURIComponent(liveAccountEmail)}/emails/${draft.json.id}`, {
      token,
      body: { isRead: true },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.isRead).toBe(true);
  });

  test("DELETE fails closed on a real message for a non-read-only account", async () => {
    const account = await api("GET", `/api/accounts/${encodeURIComponent(liveAccountEmail)}`, { token });
    const email = createEmail(db, account.json.id, { folder: "INBOX", uid: 103, isDraft: false });

    const del = await api("DELETE", `/api/accounts/${encodeURIComponent(liveAccountEmail)}/emails/${email.id}`, { token });
    expect(del.status).toBeGreaterThanOrEqual(500);

    expect(() => getEmail(db, email.id)).not.toThrow(); // still there
  });

  test("DELETE succeeds locally for a read-only account without attempting IMAP", async () => {
    const account = await api("GET", `/api/accounts/${encodeURIComponent(readOnlyAccountEmail)}`, { token });
    const email = createEmail(db, account.json.id, { folder: "INBOX", uid: 104, isDraft: false });

    const del = await api("DELETE", `/api/accounts/${encodeURIComponent(readOnlyAccountEmail)}/emails/${email.id}`, {
      token,
    });
    expect(del.status).toBe(200);
    // Never pushed at all (read-only), so it's a plain permanent local delete, not a soft one.
    expect(del.json).toEqual({ softDeleted: false });
    expect(() => getEmail(db, email.id)).toThrow();
    // The server still has it, so its UID is remembered — otherwise the next sync would download it again.
    expect(listDeletedUids(db, account.json.id, "INBOX")).toContain(104);
  });

  test("MOVE fails closed on a real message for a non-read-only account", async () => {
    const account = await api("GET", `/api/accounts/${encodeURIComponent(liveAccountEmail)}`, { token });
    const email = createEmail(db, account.json.id, { folder: "INBOX", uid: 105, isDraft: false });

    const move = await api(
      "PATCH",
      `/api/accounts/${encodeURIComponent(liveAccountEmail)}/emails/${email.id}/move/Archive`,
      { token }
    );
    expect(move.status).toBeGreaterThanOrEqual(500);

    expect(getEmail(db, email.id).folder).toBe("INBOX");
  });

  test("MOVE succeeds locally for a read-only account: the old folder's UID is tombstoned, the moved row is local-only", async () => {
    const account = await api("GET", `/api/accounts/${encodeURIComponent(readOnlyAccountEmail)}`, { token });
    const email = createEmail(db, account.json.id, { folder: "INBOX", uid: 106, isDraft: false });

    const move = await api(
      "PATCH",
      `/api/accounts/${encodeURIComponent(readOnlyAccountEmail)}/emails/${email.id}/move/Archive`,
      { token }
    );
    expect(move.status).toBe(200);
    expect(move.json.folder).toBe("Archive");
    // Never pushed, so the server still has it in INBOX under UID 106: that UID must not be re-downloaded
    // there, and the moved row no longer corresponds to any server UID (106 belongs to INBOX).
    expect(move.json.uid).toBeNull();
    expect(listDeletedUids(db, account.json.id, "INBOX")).toContain(106);
  });

  test("checking IMAP capabilities fails closed and never caches a result for an unreachable server", async () => {
    const check = await api("POST", `/api/accounts/${encodeURIComponent(liveAccountEmail)}/imap-capabilities`, { token });
    expect(check.status).toBeGreaterThanOrEqual(500);

    const account = await api("GET", `/api/accounts/${encodeURIComponent(liveAccountEmail)}`, { token });
    expect(account.json.supportsUidPlus).toBeNull();
  });

  test("bulk PATCH fails closed for every id on a non-read-only account, none of them mutated locally", async () => {
    const account = await api("GET", `/api/accounts/${encodeURIComponent(liveAccountEmail)}`, { token });
    const a = createEmail(db, account.json.id, { folder: "INBOX", uid: 201, isDraft: false, isRead: false });
    const b = createEmail(db, account.json.id, { folder: "INBOX", uid: 202, isDraft: false, isRead: false });

    const bulk = await api("PATCH", `/api/accounts/${encodeURIComponent(liveAccountEmail)}/emails/bulk`, {
      token,
      body: { ids: [a.id, b.id], isRead: true },
    });
    expect(bulk.status).toBe(200);
    expect(bulk.json.every((r: { ok: boolean }) => r.ok === false)).toBe(true);

    expect(getEmail(db, a.id).isRead).toBe(false);
    expect(getEmail(db, b.id).isRead).toBe(false);
  });

  test("bulk PATCH succeeds locally for a read-only account without attempting IMAP", async () => {
    const account = await api("GET", `/api/accounts/${encodeURIComponent(readOnlyAccountEmail)}`, { token });
    const a = createEmail(db, account.json.id, { folder: "INBOX", uid: 203, isDraft: false, isRead: false });
    const b = createEmail(db, account.json.id, { folder: "INBOX", uid: 204, isDraft: false, isRead: false });

    const bulk = await api("PATCH", `/api/accounts/${encodeURIComponent(readOnlyAccountEmail)}/emails/bulk`, {
      token,
      body: { ids: [a.id, b.id], isRead: true },
    });
    expect(bulk.status).toBe(200);
    expect(bulk.json).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: true },
    ]);
    expect(getEmail(db, a.id).isRead).toBe(true);
    expect(getEmail(db, b.id).isRead).toBe(true);
  });

  test("a mixed bulk delete (draft + real message) on a non-read-only account: the draft succeeds, the real one fails closed", async () => {
    const account = await api("GET", `/api/accounts/${encodeURIComponent(liveAccountEmail)}`, { token });
    const draft = createEmail(db, account.json.id, { folder: "Drafts", uid: null, isDraft: true });
    const real = createEmail(db, account.json.id, { folder: "INBOX", uid: 205, isDraft: false });

    const bulk = await api("DELETE", `/api/accounts/${encodeURIComponent(liveAccountEmail)}/emails/bulk`, {
      token,
      body: { ids: [draft.id, real.id] },
    });
    expect(bulk.status).toBe(200);

    const draftResult = bulk.json.find((r: { id: number }) => r.id === draft.id);
    const realResult = bulk.json.find((r: { id: number }) => r.id === real.id);
    expect(draftResult).toEqual({ id: draft.id, ok: true, softDeleted: false });
    expect(realResult.ok).toBe(false);

    expect(() => getEmail(db, draft.id)).toThrow(); // deleted
    expect(() => getEmail(db, real.id)).not.toThrow(); // still there, push failed closed
  });
});
