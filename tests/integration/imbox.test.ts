import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { createEmail, getEmail } from "../../src/server/models/emails";

const configDir = mkdtempSync(join(tmpdir(), "psmail-imbox-test-"));
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
const acc = (email: string) => ({ email, displayName: "Philipp Staender", imapHost: "h", imapPort: 993, imapUsername: "u", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "u", smtpPassword: "y" });

describe("the imbox over HTTP", () => {
  let token = "";
  const ids: Record<string, number> = {};
  let friendId = 0;
  let newsId = 0;
  const path = (email: string, id: number) => `/api/accounts/${encodeURIComponent(email)}/emails/${id}/imbox`;

  test("set up: two accounts with mail, a person I wrote to and a newsletter", async () => {
    await call("POST", "/api/users", { body: { username: "phil", password: "pw" } });
    token = (await call("POST", "/api/auth/login", { body: { username: "phil", password: "pw" } })).json.token;
    for (const email of ["philipp@example.com", "philipp@work.example.org"]) ids[email] = (await call("POST", "/api/accounts", { token, body: acc(email) })).json.id;

    createEmail(db, ids["philipp@example.com"]!, { folder: "Sent", isDraft: false, from: [{ address: "philipp@example.com" }], to: [{ address: "anna@friend.example" }], subject: "Hi", plainText: "x", date: "2026-05-01T00:00:00Z" });
    friendId = createEmail(db, ids["philipp@example.com"]!, { folder: "INBOX", isDraft: false, from: [{ name: "Anna", address: "anna@friend.example" }], to: [{ address: "philipp@example.com" }], subject: "Samstag?", plainText: "Hey Philipp, Zeit am Samstag?", date: "2026-05-02T00:00:00Z" }).id;
    newsId = createEmail(db, ids["philipp@example.com"]!, { folder: "INBOX", isDraft: false, from: [{ address: "newsletter@shop.example" }], to: [{ address: "philipp@example.com" }], subject: "Rabatt", plainText: "40% Rabatt. Abbestellen.", headersRaw: "List-Unsubscribe: <mailto:x@shop.example>", date: "2026-05-03T00:00:00Z" }).id;
    createEmail(db, ids["philipp@work.example.org"]!, { folder: "INBOX", isDraft: false, from: [{ name: "Julia", address: "julia@work.example.org" }], to: [{ address: "philipp@work.example.org" }], subject: "Meeting", plainText: "Hi Philipp, Besprechung morgen zum Projekt?", date: "2026-05-04T00:00:00Z" });
  });

  test("everything needs a login", async () => {
    expect((await call("POST", "/api/imbox/classify", { body: {} })).status).toBe(401);
    expect((await call("GET", path("philipp@example.com", friendId))).status).toBe(401);
  });

  test("classify: every account by default, then nothing to do, then --force; verdicts are stored", async () => {
    const first = await call("POST", "/api/imbox/classify", { token, body: {} });
    expect(first.status).toBe(200);
    const totals = (r: { results: { examined: number; important: number }[] }) => [r.results.reduce((n, x) => n + x.examined, 0), r.results.reduce((n, x) => n + x.important, 0)];
    expect(totals(first.json)).toEqual([3, 2]);
    expect(first.json.results.map((r: { account: string }) => r.account).sort()).toEqual(["philipp@example.com", "philipp@work.example.org"]);
    expect(getEmail(db, friendId).imbox).toBe(true);
    expect(getEmail(db, newsId).imbox).toBe(false);

    expect(totals((await call("POST", "/api/imbox/classify", { token, body: {} })).json)).toEqual([0, 0]);
    expect(totals((await call("POST", "/api/imbox/classify", { token, body: { force: true } })).json)).toEqual([3, 2]);
  });

  test("one account only; an unknown account is a 404, a bad list a 400; a disabled account is skipped", async () => {
    db.exec("UPDATE emails SET imbox = NULL");
    const one = await call("POST", "/api/imbox/classify", { token, body: { accounts: ["philipp@work.example.org"] } });
    expect(one.json.results).toEqual([{ account: "philipp@work.example.org", examined: 1, important: 1, notImportant: 0 }]);
    expect(getEmail(db, friendId).imbox).toBeNull(); // the other account wasn't touched

    expect((await call("POST", "/api/imbox/classify", { token, body: { accounts: ["nobody@example.com"] } })).status).toBe(404);
    expect((await call("POST", "/api/imbox/classify", { token, body: { accounts: "philipp@example.com" } })).status).toBe(400);

    await call("PATCH", "/api/accounts/philipp%40work.example.org", { token, body: { disabled: true } });
    const all = await call("POST", "/api/imbox/classify", { token, body: {} });
    expect(all.json.results.find((r: { account: string }) => r.account === "philipp@work.example.org").skipped).toBe("the account is disabled");
    await call("PATCH", "/api/accounts/philipp%40work.example.org", { token, body: { disabled: false } });
  });

  test("explain: the score and every reason, and what is stored", async () => {
    const res = await call("GET", path("philipp@example.com", friendId), { token });
    expect(res.status).toBe(200);
    expect(res.json.important).toBe(true);
    expect(res.json.stored).toBe(true);
    expect(res.json.reasons.some((r: { signal: string }) => r.signal === "you have written to this address")).toBe(true);
    expect(Math.abs(res.json.reasons.reduce((n: number, r: { points: number }) => n + r.points, 0) - res.json.score)).toBeLessThan(0.02);

    const news = await call("GET", path("philipp@example.com", newsId), { token });
    expect(news.json.important).toBe(false);
    expect(news.json.reasons.some((r: { signal: string }) => r.signal.includes("mailing-list"))).toBe(true);
    expect((await call("GET", path("philipp@work.example.org", friendId), { token })).status).toBe(404); // not that account's message
  });

  test("override by hand: true/false/null, and it shows in the message and the imbox list", async () => {
    const put = (imbox: unknown) => call("PUT", path("philipp@example.com", newsId), { token, body: { imbox } });
    expect((await put(true)).json.imbox).toBe(true);
    expect((await call("GET", "/api/unified/imbox", { token })).json.map((r: { subject: string }) => r.subject)).toContain("Rabatt");
    expect((await put(false)).json.imbox).toBe(false);
    expect((await call("GET", "/api/unified/imbox", { token })).json.map((r: { subject: string }) => r.subject)).not.toContain("Rabatt");
    expect((await put(null)).json.imbox).toBeNull();
    expect((await put("maybe")).status).toBe(400);
  });

  test("GET /api/unified/imbox lists the important messages; the setting is saved", async () => {
    await call("POST", "/api/imbox/classify", { token, body: { force: true } });
    const list = await call("GET", "/api/unified/imbox", { token });
    expect(list.json.map((r: { subject: string }) => r.subject)).toEqual(["Meeting", "Samstag?"]); // newest first, both accounts
    expect((await call("GET", "/api/unified/nothing", { token })).status).toBe(404);

    expect((await call("PATCH", "/api/settings", { token, body: { imboxEnabled: true } })).json.imboxEnabled).toBe(true);
    expect((await call("PATCH", "/api/settings", { token, body: { imboxEnabled: "yes" } })).status).toBe(400);
  });

  test("the CLI: imbox classify [accounts] [--force] and imbox explain, against the running API", async () => {
    db.exec("UPDATE emails SET imbox = NULL");
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", "src/cli/index.ts", "imbox", ...args, "--url", base, "--user", "phil"], {
        cwd: process.cwd(),
        env: { ...process.env, PSMAIL_PASSWORD: "pw" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, out, err };
    };

    const one = await run("classify", "philipp@example.com");
    expect(one.code).toBe(0);
    expect(one.out).toContain("philipp@example.com: 2 classified — 1 important, 1 not");
    expect(one.out).not.toContain("work.example.org");

    const all = await run("classify");
    expect(all.out).toContain("philipp@work.example.org: 1 classified");
    expect(all.out).toContain("philipp@example.com: 0 classified");
    expect((await run("classify")).out).toContain("Nothing to do"); // everything has a verdict now

    const forced = await run("classify", "philipp@example.com", "--force"); // --force after the address
    expect(forced.out).toContain("philipp@example.com: 2 classified");
    const forcedFirst = await run("classify", "--force", "philipp@example.com"); // and before it: the address isn't swallowed by the flag
    expect(forcedFirst.out).toContain("philipp@example.com: 2 classified");
    expect(forcedFirst.out).not.toContain("work.example.org");

    const explain = await run("explain", "philipp@example.com", String(friendId));
    expect(explain.out).toContain("IMPORTANT");
    expect(explain.out).toContain("you have written to this address");

    const bad = await run("explain", "philipp@example.com");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Usage: psmail imbox explain");
  });
});
