import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { createEmail, getEmail } from "../../src/server/models/emails";
import { aiHttp } from "../../src/server/services/ai";
import { ApiClient, type SummarizeEvent } from "../../src/cli/client";

const configDir = mkdtempSync(join(tmpdir(), "psmail-summarize-test-"));
process.env.PSMAIL_CONFIG_DIR = configDir;

const db = createTestDb();
const server = startTestServer(db);
const base = server.url.toString().replace(/\/$/, "");
const realAiFetch = aiHttp.fetch;

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});
afterEach(() => {
  aiHttp.fetch = realAiFetch;
});

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** Every AI call answers `answer(userText)`; returns what was asked. */
function fakeAi(answer: (user: string) => string | Error) {
  const asked: string[] = [];
  aiHttp.fetch = async (_url, init) => {
    const user = JSON.parse(String(init!.body)).messages[0].content as string;
    asked.push(user);
    const result = answer(user);
    if (result instanceof Error) return new Response(JSON.stringify({ error: { message: result.message } }), { status: 401 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: result }] }));
  };
  return asked;
}

describe("summarizing stored mail in bulk (psmail summarize)", () => {
  let token: string;
  const ids: Record<string, number> = {};
  let accountIds: number[] = [];

  function addMail(accountId: number, folder: string, subject: string, date: string, over: Record<string, unknown> = {}) {
    return createEmail(db, accountId, { folder, isDraft: false, subject, from: [{ address: "x@y.z" }], date, plainText: `Body of ${subject}`, ...over }).id;
  }

  test("set up: two accounts with mail in two folders, a provider and a summarize skill", async () => {
    await api("POST", "/api/users", { body: { username: "bea", password: "pw" } });
    token = (await api("POST", "/api/auth/login", { body: { username: "bea", password: "pw" } })).json.token;
    for (const email of ["a@example.com", "b@example.com"]) {
      const acc = await api("POST", "/api/accounts", {
        token,
        body: { email, imapHost: "h", imapPort: 993, imapUsername: email, imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: email, smtpPassword: "y" },
      });
      accountIds.push(acc.json.id);
    }
    ids.a1 = addMail(accountIds[0]!, "INBOX", "A old", "2026-01-01T00:00:00Z");
    ids.a2 = addMail(accountIds[0]!, "INBOX", "A new", "2026-01-03T00:00:00Z");
    ids.a3 = addMail(accountIds[0]!, "Archive", "A archived", "2026-01-02T00:00:00Z");
    ids.a4 = addMail(accountIds[0]!, "INBOX", "A empty", "2026-01-04T00:00:00Z", { plainText: null, htmlText: null });
    ids.b1 = addMail(accountIds[1]!, "INBOX", "B one", "2026-01-05T00:00:00Z");
    const provider = await api("POST", "/api/ai/apis", { token, body: { vendor: "anthropic", model: "m", apiKey: "k" } });
    await api("POST", "/api/ai/skills", { token, body: { aiApiId: provider.json.id, category: "summarize", prompt: "You summarize." } });
  });

  test("it needs a login, and a summarize skill", async () => {
    expect((await api("POST", "/api/ai/summarize")).status).toBe(401);
    // (the skill exists here; the missing-skill answer is covered by the ai endpoint tests' wording)
    expect((await api("POST", "/api/ai/summarize", { token, body: { accounts: ["nobody@example.com"] } })).status).toBe(404);
    expect((await api("POST", "/api/ai/summarize", { token, body: { folder: "" } })).status).toBe(400);
  });

  test("by default: every account and folder, only messages without a summary, newest first; empty mail is skipped", async () => {
    const asked = fakeAi(user => `Summary: ${user.split("\n")[0]}`);
    const res = await api("POST", "/api/ai/summarize", { token, body: {} });

    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([
      { account: "a@example.com", examined: 4, summarized: 3, failed: 0 },
      { account: "b@example.com", examined: 1, summarized: 1, failed: 0 },
    ]);
    expect(asked.map(text => text.split("\n")[0])).toEqual(["Subject: A new", "Subject: A archived", "Subject: A old", "Subject: B one"]);
    expect(getEmail(db, ids.a1!).aiSummary).toBe("Summary: Subject: A old");
    expect(getEmail(db, ids.a4!).aiSummary).toBeNull();

    // Again: nothing left without a summary.
    asked.length = 0;
    const again = await api("POST", "/api/ai/summarize", { token, body: {} });
    expect(asked).toEqual([]);
    expect(again.json.results.map((r: { summarized: number }) => r.summarized)).toEqual([0, 0]);
  });

  test("force redoes them; account and folder limit what is looked at (folder ignoring case)", async () => {
    const asked = fakeAi(user => `Second: ${user.split("\n")[0]}`);
    await api("POST", "/api/ai/summarize", { token, body: { accounts: ["a@example.com"], folder: "inbox", force: true } });
    expect(asked.map(text => text.split("\n")[0])).toEqual(["Subject: A new", "Subject: A old"]); // no A archived, nothing of B; A empty has no text
    expect(getEmail(db, ids.a2!).aiSummary).toBe("Second: Subject: A new");
    expect(getEmail(db, ids.a3!).aiSummary).toBe("Summary: Subject: A archived"); // untouched
    expect(getEmail(db, ids.b1!).aiSummary).toBe("Summary: Subject: B one");

    const none = await api("POST", "/api/ai/summarize", { token, body: { folder: "Nope", force: true } });
    expect(none.json.results.map((r: { examined: number }) => r.examined)).toEqual([0, 0]);
  });

  test("the stream says what it is doing: start, account, working before each AI call, message, progress, done", async () => {
    db.query("UPDATE emails SET ai_summary = NULL").run();
    fakeAi(user => `S ${user.split("\n")[0]}`);
    const client = new ApiClient(base);
    client.setToken(token);
    const events: SummarizeEvent[] = [];
    const done = await client.summarizeStream({ accounts: ["b@example.com"], force: false, verbose: true }, e => events.push(e));

    expect(events.map(e => e.type)).toEqual(["start", "account", "working", "message", "progress", "account-done", "done"]);
    expect(events[0]).toMatchObject({ type: "start", accounts: ["b@example.com"], folder: null, force: false });
    expect(events[1]).toMatchObject({ type: "account", account: "b@example.com", total: 1, folders: ["INBOX"] });
    expect(events[2]).toMatchObject({ type: "working", subject: "B one", done: 1, total: 1 });
    expect(events[3]).toMatchObject({ type: "message", ok: true, summary: "S Subject: B one" }); // --verbose: the summary itself
    expect(done.results).toEqual([{ account: "b@example.com", examined: 1, summarized: 1, failed: 0 }]);

    // Without verbose the summary isn't sent along.
    const quiet: SummarizeEvent[] = [];
    await client.summarizeStream({ accounts: ["b@example.com"], force: true, verbose: false }, e => quiet.push(e));
    expect(quiet.find(e => e.type === "message")).not.toHaveProperty("summary");
  });

  test("a failing message is reported and skipped; five failures in a row stop the account", async () => {
    db.query("UPDATE emails SET ai_summary = NULL").run();
    for (let i = 0; i < 6; i++) addMail(accountIds[1]!, "INBOX", `B extra ${i}`, `2026-02-0${i + 1}T00:00:00Z`);
    fakeAi(() => new Error("invalid x-api-key"));
    const client = new ApiClient(base);
    client.setToken(token);
    const events: SummarizeEvent[] = [];
    await client.summarizeStream({ accounts: ["b@example.com"], force: false, verbose: false }, e => events.push(e));

    const failures = events.filter(e => e.type === "message" && !e.ok);
    expect(failures).toHaveLength(5);
    expect(failures[0]).toMatchObject({ error: expect.stringContaining("invalid x-api-key") });
    expect(events.find(e => e.type === "account-done")).toMatchObject({ examined: 5, summarized: 0, failed: 5, skipped: "stopped after 5 failures in a row" });
  });
});

describe("the command line", () => {
  test("psmail summarize prints what it does; --folder needs a name", async () => {
    // A user of its own so nothing above interferes.
    await api("POST", "/api/users", { body: { username: "cli", password: "pw" } });
    const token = (await api("POST", "/api/auth/login", { body: { username: "cli", password: "pw" } })).json.token;
    const acc = await api("POST", "/api/accounts", {
      token,
      body: { email: "c@example.com", imapHost: "h", imapPort: 993, imapUsername: "c", imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: "c", smtpPassword: "y" },
    });
    createEmail(db, acc.json.id, { folder: "INBOX", isDraft: false, subject: "Hello CLI", from: [{ address: "x@y.z" }], date: "2026-03-01T00:00:00Z", plainText: "Body" });
    const provider = await api("POST", "/api/ai/apis", { token, body: { vendor: "anthropic", model: "m", apiKey: "k" } });
    await api("POST", "/api/ai/skills", { token, body: { aiApiId: provider.json.id, category: "summarize", prompt: "You summarize." } });

    // The server runs in this process, so its AI calls are faked here; the CLI is its own process talking to it.
    fakeAi(() => "- point one");
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", "src/cli/index.ts", "summarize", ...args, "--user", "cli", "--password", "pw", "--url", base], { stdout: "pipe", stderr: "pipe", cwd: join(import.meta.dir, "../..") });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { out, err, code: await proc.exited };
    };

    const first = await run("c@example.com", "--folder", "INBOX", "--verbose");
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toContain("Summarizing 1 account(s): c@example.com — folder INBOX");
    expect(first.out).toContain("1 message(s) to summarize in INBOX");
    expect(first.out).toMatch(/summarized\s+#\d+ INBOX: Hello CLI/);
    expect(first.out).toContain("- point one"); // --verbose
    expect(first.out).toContain("1 message(s) summarized");

    const second = await run();
    expect(second.out).toContain("Nothing to do — every message has a summary already (use --force to summarize them again).");

    const bad = await run("--folder");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--folder needs a folder name");
  }, 60_000);
});
