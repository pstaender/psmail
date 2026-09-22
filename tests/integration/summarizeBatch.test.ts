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

  test("a timeout is logged and the batch moves on to the next message — any number of them in a row, never stopping the account", async () => {
    db.query("UPDATE emails SET ai_summary = NULL").run();
    // A fresh batch of 7 messages: more than the "5 failures in a row" threshold that applies to hard failures.
    const addedNow = new Set<number>();
    for (let i = 0; i < 7; i++) addedNow.add(addMail(accountIds[1]!, "INBOX", `B timeout ${i}`, `2026-04-0${i + 1}T00:00:00Z`));
    aiHttp.fetch = async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    };
    const client = new ApiClient(base);
    client.setToken(token);
    const events: SummarizeEvent[] = [];
    await client.summarizeStream({ accounts: ["b@example.com"], force: false, verbose: false }, e => events.push(e));

    const failures = events.filter(e => e.type === "message" && !e.ok) as { id: number; timedOut?: boolean }[];
    // Every message in this batch was attempted — none skipped by a circuit breaker — and the new ones are among them.
    expect(addedNow.size).toBeLessThanOrEqual(failures.length);
    expect([...addedNow].every(id => failures.some(f => f.id === id))).toBe(true);
    expect(failures.every(e => e.timedOut)).toBe(true);
    expect(failures[0]).toMatchObject({ error: expect.stringContaining("it didn't answer in time") });
    const done = events.find(e => e.type === "account-done") as { examined: number; summarized: number; failed: number; skipped?: string };
    expect(done.failed).toBe(failures.length);
    expect(done.skipped).toBeUndefined(); // not stopped — timeouts don't count toward the circuit breaker

    // A mix: timeouts never contribute to the "5 in a row" count, but a real failure in between still does when repeated.
    db.query("UPDATE emails SET ai_summary = NULL").run();
    let call = 0;
    aiHttp.fetch = async () => {
      call++;
      if (call % 2 === 1) throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); // odd calls: timeout
      return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 }); // even calls: a hard failure
    };
    const mixed: SummarizeEvent[] = [];
    await client.summarizeStream({ accounts: ["b@example.com"], force: false, verbose: false }, e => mixed.push(e));
    const mixedFailures = mixed.filter(e => e.type === "message" && !e.ok) as { timedOut?: boolean }[];
    // 5 non-timeout ("hard") failures interleaved with timeouts still triggers the breaker — just later than 5 raw failures would.
    expect(mixedFailures.filter(e => !e.timedOut)).toHaveLength(5);
    const mixedDone = mixed.find(e => e.type === "account-done") as { skipped?: string };
    expect(mixedDone.skipped).toBe("stopped after 5 failures in a row");
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

describe("which profile a command signs in as (no --user): the one that has the account", () => {
  const spawn = async (args: string[], env: Record<string, string> = { PSMAIL_PASSWORD: "" }) => {
    const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args, "--url", base], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, ...env },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { out, err, code: await proc.exited };
  };

  test("the profile that owns the account is found; --user must own it; unknown accounts and other passwords are explained", async () => {
    // "default" has no account of the address, "philipp" has; both without a password. "secret" has its own password.
    await api("POST", "/api/users", { body: { username: "default", password: "" } });
    await api("POST", "/api/users", { body: { username: "philipp", password: "" } });
    await api("POST", "/api/users", { body: { username: "secret", password: "pw" } });
    const login = async (username: string, password: string) => (await api("POST", "/api/auth/login", { body: { username, password } })).json.token as string;
    const add = async (token: string, email: string) =>
      (await api("POST", "/api/accounts", { token, body: { email, imapHost: "h", imapPort: 993, imapUsername: email, imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: email, smtpPassword: "y" } })).json.id as number;
    const philipp = await login("philipp", "");
    const id = await add(philipp, "pstaender@mailbox.org");
    const getEmailIdFor = (accountId: number) => db.query<{ id: number }, [number]>("SELECT id FROM emails WHERE account_id = ?").get(accountId)!.id;
    createEmail(db, id, { folder: "INBOX", isDraft: false, subject: "Hi", from: [{ address: "x@y.z" }], date: "2026-03-01T00:00:00Z", plainText: "Body" });
    await add(await login("default", ""), "other@example.com");
    await add(await login("secret", "pw"), "hidden@example.com");
    const provider = await api("POST", "/api/ai/apis", { token: philipp, body: { vendor: "anthropic", model: "m", apiKey: "k" } });
    await api("POST", "/api/ai/skills", { token: philipp, body: { aiApiId: provider.json.id, category: "summarize", prompt: "You summarize." } });
    fakeAi(() => "- fine");

    const owners = await api("GET", "/api/account-owners?email=PSTAENDER@mailbox.org");
    expect(owners.json).toEqual([{ username: "philipp" }]); // case-insensitive, and only names
    expect((await api("GET", "/api/account-owners?email=nobody@example.com")).json).toEqual([]);
    expect((await api("GET", "/api/account-owners")).status).toBe(400);

    // Without --user: the profile that has the account is named and used — not "default".
    const found = await spawn(["summarize", "pstaender@mailbox.org", "--folder", "Inbox"]);
    expect(found.err).toBe("");
    expect(found.out).toContain('The account pstaender@mailbox.org belongs to the profile "philipp".');
    expect(found.out).toContain('as "philipp"');
    expect(found.out).toContain("1 message(s) summarized");

    // imbox too.
    const imbox = await spawn(["imbox", "classify", "pstaender@mailbox.org"]);
    expect(imbox.err).toBe("");
    expect(imbox.out).toContain('as "philipp"');
    const explain = await spawn(["imbox", "explain", "pstaender@mailbox.org", String(getEmailIdFor(id))]);
    expect(explain.err).toBe("");
    expect(explain.out).toContain('as "philipp"');

    // With --user, that profile has to have it — and the error says who does.
    const wrong = await spawn(["summarize", "pstaender@mailbox.org", "--user", "default"]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('"default" has no account pstaender@mailbox.org: pstaender@mailbox.org belongs to "philipp" — use --user philipp.');

    // Nobody has it.
    const nobody = await spawn(["summarize", "nobody@example.com"]);
    expect(nobody.code).toBe(1);
    expect(nobody.err).toContain("No profile has the account nobody@example.com.");

    // Accounts of two profiles at once can't be done in one run.
    const mixed = await spawn(["summarize", "pstaender@mailbox.org", "other@example.com"]);
    expect(mixed.err).toContain("belong to different profiles");

    // The profile found is asked for its password (here given): a profile with a password of its own works the same.
    const hidden = await spawn(["summarize", "hidden@example.com", "--password", "pw"]);
    expect(hidden.out).toContain('The account hidden@example.com belongs to the profile "secret".');
    expect(hidden.out).toContain('as "secret"'); // signed in; that profile just has no summarize skill
    expect(hidden.err).toContain("No \"summarize\" skill");
  }, 60_000);
});
