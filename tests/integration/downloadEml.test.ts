import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { addAttachment, createEmail } from "../../src/server/models/emails";

const configDir = mkdtempSync(join(tmpdir(), "psmail-eml-test-"));
process.env.PSMAIL_CONFIG_DIR = configDir;

const db = createTestDb();
const server = startTestServer(db);
const base = server.url.toString().replace(/\/$/, "");

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

async function post(path: string, body: unknown, token?: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

const account = (email: string) => ({
  email, imapHost: "127.0.0.1", imapPort: 1, imapUsername: "u", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "y",
});
const from = [{ name: "Alice", address: "alice@example.com" }];

describe("POST /api/accounts/:email/emails/download", () => {
  let token = "";
  let accountId = 0;
  const path = (email = "eml@example.com") => `/api/accounts/${encodeURIComponent(email)}/emails/download`;
  const ids: number[] = [];

  test("set up: an account, three messages (one with an attachment) and a server that can't be reached", async () => {
    await post("/api/users", { username: "jo", password: "pw" });
    token = ((await (await post("/api/auth/login", { username: "jo", password: "pw" })).json()) as { token: string }).token;
    accountId = ((await (await post("/api/accounts", account("eml@example.com"), token)).json()) as { id: number }).id;

    for (const [uid, subject] of [[null, "Draft-ish"], [7, "From the server"], [8, "From the server"]] as const) {
      ids.push(createEmail(db, accountId, { folder: "INBOX", uid, from, to: [{ name: "", address: "me@example.com" }], subject, date: "2024-05-01T10:00:00Z", plainText: `body of ${subject}` }).id);
    }
    const file = join(configDir, "note.txt");
    writeFileSync(file, "attached text");
    addAttachment(db, ids[0]!, { filename: "note.txt", contentType: "text/plain", size: 13, filePath: file });
  });

  test("one message comes as the .eml itself", async () => {
    const res = await post(path(), { ids: [ids[0]] }, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("message/rfc822");
    expect(res.headers.get("content-disposition")).toContain("2024-05-01 Draft-ish.eml");

    const parsed = await simpleParser(Buffer.from(await res.arrayBuffer()));
    expect(parsed.subject).toBe("Draft-ish");
    expect(parsed.text).toContain("body of Draft-ish");
    expect(parsed.attachments.map(a => a.filename)).toEqual(["note.txt"]);
  });

  test("a message with a UID whose server can't be reached falls back to the stored copy instead of failing", async () => {
    const res = await post(path(), { ids: [ids[1]] }, token);
    expect(res.status).toBe(200);
    expect((await simpleParser(Buffer.from(await res.arrayBuffer()))).text).toContain("body of From the server");
  });

  test("several messages come as a zip of .eml files, with clashing names numbered", async () => {
    const res = await post(path(), { ids }, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("messages.zip");

    const zipFile = join(configDir, "out.zip");
    writeFileSync(zipFile, Buffer.from(await res.arrayBuffer()));
    const listing = await Bun.$`unzip -Z1 ${zipFile}`.text();
    expect(listing.trim().split("\n").sort()).toEqual(["2024-05-01 Draft-ish.eml", "2024-05-01 From the server (2).eml", "2024-05-01 From the server.eml"]);
    expect((await Bun.$`unzip -tq ${zipFile}`.text())).toContain("No errors detected"); // a real unzip accepts it
    const first = await Bun.$`unzip -p ${zipFile} ${"2024-05-01 Draft-ish.eml"}`.text();
    expect(first).toContain("Subject: Draft-ish");
  });

  test("the same id twice is one message", async () => {
    const res = await post(path(), { ids: [ids[0], ids[0]] }, token);
    expect(res.headers.get("content-type")).toBe("message/rfc822");
  });

  test("a disabled account can still be downloaded from (reading), and makes no connection", async () => {
    await fetch(`${base}/api/accounts/${encodeURIComponent("eml@example.com")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ disabled: true }),
    });
    const res = await post(path(), { ids: [ids[1]] }, token);
    expect(res.status).toBe(200);
    expect((await simpleParser(Buffer.from(await res.arrayBuffer()))).subject).toBe("From the server");
  });

  test("bad requests: no ids, too many, a message that isn't this account's, another user's account", async () => {
    expect((await post(path(), { ids: [] }, token)).status).toBe(400);
    expect((await post(path(), { ids: Array.from({ length: 5001 }, (_, i) => i + 1) }, token)).status).toBe(400);

    await post("/api/accounts", account("other@example.com"), token);
    expect((await post(path("other@example.com"), { ids: [ids[0]] }, token)).status).toBe(404);

    await post("/api/users", { username: "kim", password: "pw" });
    const kim = ((await (await post("/api/auth/login", { username: "kim", password: "pw" })).json()) as { token: string }).token;
    expect((await post(path(), { ids: [ids[0]] }, kim)).status).toBe(404);
    expect((await post(path(), { ids: [ids[0]] })).status).toBe(401);
  });
});
