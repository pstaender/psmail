import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/db";
import { startTestServer } from "../helpers/server";
import { createEmail, getEmail } from "../../src/server/models/emails";
import { decryptSecret, deriveEncryptionKey } from "../../src/server/crypto/secrets";
import { aiHttp } from "../../src/server/services/ai";

const configDir = mkdtempSync(join(tmpdir(), "psmail-ai-test-"));
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

/** Makes every AI call answer with `answer(systemPrompt, userText)`, and records what was sent. */
function fakeAi(answer: (system: string, user: string) => string) {
  const sent: { system: string; user: string }[] = [];
  aiHttp.fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    const call = { system: body.system as string, user: body.messages[0].content as string };
    sent.push(call);
    return new Response(JSON.stringify({ content: [{ type: "text", text: answer(call.system, call.user) }] }));
  };
  return sent;
}

describe("AI endpoints", () => {
  let token: string;
  let userId: number;
  let apiId: number;
  let emailId: number;
  const account = "me@example.com";
  const emailPath = () => `/api/accounts/${encodeURIComponent(account)}/emails`;

  test("set up a user, an account with a message, an AI API and skills", async () => {
    const created = await api("POST", "/api/users", { body: { username: "ann", password: "pw" } });
    userId = created.json.id;
    token = (await api("POST", "/api/auth/login", { body: { username: "ann", password: "pw" } })).json.token;

    const acc = await api("POST", "/api/accounts", {
      token,
      body: { email: account, imapHost: "h", imapPort: 993, imapUsername: account, imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: account, smtpPassword: "y" },
    });
    emailId = createEmail(db, acc.json.id, {
      folder: "INBOX", isDraft: false, subject: "Quarterly report", from: [{ name: "Boss", address: "boss@x.com" }],
      date: "2026-01-02T00:00:00.000Z", plainText: "Revenue is up 12%. Please send the slides by Friday.",
    }).id;

    const made = await api("POST", "/api/ai/apis", { token, body: { vendor: "anthropic", model: "claude-opus-5", apiKey: "sk-ant-secret" } });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ vendor: "anthropic", hasKey: true, name: "", label: "Anthropic.claude-opus-5" });
    expect(JSON.stringify(made.json)).not.toContain("sk-ant-secret");
    apiId = made.json.id;

    expect((await api("GET", "/api/ai/apis", { token })).json).toHaveLength(1);
    expect((await api("POST", "/api/ai/apis", { token, body: { vendor: "openai", model: "x" } })).status).toBe(400); // key missing
  });

  test("everything needs a login", async () => {
    for (const [method, path] of [["GET", "/api/ai/apis"], ["GET", "/api/ai/skills"], ["POST", "/api/ai/run"], ["POST", `${emailPath()}/${emailId}/ai/summarize`]] as const) {
      expect((await api(method, path)).status).toBe(401);
    }
  });

  test("without a skill, the actions say what to set up", async () => {
    const res = await api("POST", `${emailPath()}/${emailId}/ai/summarize`, { token });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("Settings → AI");
    expect((await api("POST", "/api/ai/run", { token, body: { category: "grammar", text: "hello" } })).status).toBe(409);
  });

  test("skills are created against one of the user's APIs", async () => {
    const skills: [string, string][] = [
      ["summarize", "You summarize."],
      ["categorize", "You categorize. JSON array."],
      ["translate", "Translate into {{language}}."],
      ["grammar", "You proofread."],
    ];
    for (const [category, prompt] of skills) {
      expect((await api("POST", "/api/ai/skills", { token, body: { aiApiId: apiId, category, prompt } })).status).toBe(201);
    }
    expect((await api("POST", "/api/ai/skills", { token, body: { aiApiId: 999, category: "improve", prompt: "p" } })).status).toBe(404);
    expect((await api("GET", "/api/ai/skills", { token })).json).toHaveLength(4);
  });

  test("summarize stores the summary and, with a categorize skill, the taxonomy — using each skill's prompt", async () => {
    const sent = fakeAi(system => (system.includes("categorize") ? '["report", "action needed"]' : "- Revenue up 12%\n- Slides due Friday"));
    const res = await api("POST", `${emailPath()}/${emailId}/ai/summarize`, { token });

    expect(res.status).toBe(200);
    expect(res.json.email).toMatchObject({ aiSummary: "- Revenue up 12%\n- Slides due Friday", taxonomyList: ["report", "action needed"] });
    expect(res.json.taxonomyError).toBeUndefined();
    expect(sent.map(s => s.system)).toEqual(["You summarize.", "You categorize. JSON array."]);
    expect(sent[0]!.user).toContain("Subject: Quarterly report");
    expect(sent[0]!.user).toContain("Please send the slides by Friday.");

    // Stored permanently: a fresh read of the message has them.
    expect(getEmail(db, emailId)).toMatchObject({ aiSummary: "- Revenue up 12%\n- Slides due Friday", taxonomyList: ["report", "action needed"] });
    const read = await api("GET", `${emailPath()}/${emailId}`, { token });
    expect(read.json.aiSummary).toContain("Revenue up 12%");
  });

  test("a failing categorize step doesn't lose the summary", async () => {
    aiHttp.fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      if (String(body.system).includes("categorize")) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "New summary" }] }));
    };
    const res = await api("POST", `${emailPath()}/${emailId}/ai/summarize`, { token });
    expect(res.status).toBe(200);
    expect(res.json.email.aiSummary).toBe("New summary");
    expect(res.json.taxonomyError).toContain("overloaded");
    expect(res.json.email.taxonomyList).toEqual(["report", "action needed"]); // the earlier ones are kept
  });

  test("translate uses the requested language, else the user's setting, and stores translation and language", async () => {
    const sent = fakeAi((system, user) => `[${system}] ${user.split("\n\n")[1]}`);

    const german = await api("POST", `${emailPath()}/${emailId}/ai/translate`, { token, body: { language: "German" } });
    expect(german.json.email).toMatchObject({ translatedLanguage: "German" });
    expect(german.json.email.translatedText).toContain("[Translate into German.]");
    expect(sent[0]!.system).toBe("Translate into German.");

    await api("PATCH", "/api/settings", { token, body: { aiTargetLanguage: "French" } });
    const french = await api("POST", `${emailPath()}/${emailId}/ai/translate`, { token });
    expect(french.json.email.translatedLanguage).toBe("French");
    expect(getEmail(db, emailId).translatedText).toContain("Translate into French.");
  });

  test("with several skills of a category the request can choose one; without a choice the first is used", async () => {
    const second = await api("POST", "/api/ai/skills", { token, body: { aiApiId: apiId, category: "translate", name: "Formal", prompt: "Translate formally into {{language}}." } });
    expect(second.json).toMatchObject({ name: "Formal" });
    const list = (await api("GET", "/api/ai/skills", { token })).json as { id: number; category: string; name: string }[];
    expect(list.find(s => s.category === "summarize")!.name).toBe("summarize"); // created without a name: the category

    const sent = fakeAi(() => "ok");
    await api("POST", `${emailPath()}/${emailId}/ai/translate`, { token, body: { language: "German", skillId: second.json.id } });
    await api("POST", `${emailPath()}/${emailId}/ai/translate`, { token, body: { language: "German" } });
    expect(sent.map(s => s.system)).toEqual(["Translate formally into German.", "Translate into German."]);

    // A skill of another category (or someone else's) is refused.
    const summarizer = list.find(s => s.category === "summarize")!;
    expect((await api("POST", `${emailPath()}/${emailId}/ai/translate`, { token, body: { skillId: summarizer.id } })).status).toBe(400);
    expect((await api("POST", `${emailPath()}/${emailId}/ai/translate`, { token, body: { skillId: 9999 } })).status).toBe(404);

    // Composing too.
    const grammar2 = await api("POST", "/api/ai/skills", { token, body: { aiApiId: apiId, category: "grammar", name: "Strict", prompt: "Proofread strictly." } });
    sent.length = 0;
    await api("POST", "/api/ai/run", { token, body: { category: "grammar", text: "hi", skillId: grammar2.json.id } });
    expect(sent[0]!.system).toBe("Proofread strictly.");

    await api("DELETE", `/api/ai/skills/${second.json.id}`, { token });
    await api("DELETE", `/api/ai/skills/${grammar2.json.id}`, { token });
  });

  test("run (composing) returns the text without storing anything, and only for compose categories", async () => {
    const sent = fakeAi(() => "Corrected text");
    const res = await api("POST", "/api/ai/run", { token, body: { category: "grammar", text: "i has a mistake" } });
    expect(res.json).toEqual({ text: "Corrected text" });
    expect(sent[0]).toEqual({ system: "You proofread.", user: "i has a mistake" });

    expect((await api("POST", "/api/ai/run", { token, body: { category: "categorize", text: "x" } })).status).toBe(400);
    expect((await api("POST", "/api/ai/run", { token, body: { category: "grammar", text: "  " } })).status).toBe(400);
    expect((await api("POST", "/api/ai/run", { token, body: { category: "improve", text: "x" } })).status).toBe(409); // no improve skill
  });

  test("every successful call adds its tokens to the provider's record; failed calls add nothing", async () => {
    const usageOf = async () => {
      const list = (await api("GET", "/api/ai/apis", { token })).json as { id: number; calls: number; inputTokens: number; outputTokens: number }[];
      const mine = list.find(a => a.id === apiId)!;
      return [mine.calls, mine.inputTokens, mine.outputTokens];
    };
    const before = await usageOf();

    // The vendor reports usage: those numbers are added.
    aiHttp.fetch = async () => new Response(JSON.stringify({ content: [{ type: "text", text: "fixed" }], usage: { input_tokens: 200, output_tokens: 40 } }));
    await api("POST", "/api/ai/run", { token, body: { category: "grammar", text: "teh text" } });
    expect(await usageOf()).toEqual([before[0]! + 1, before[1]! + 200, before[2]! + 40]);

    // Summarize + categorize together are two calls.
    aiHttp.fetch = async (_url, init) => {
      const categorize = String(JSON.parse(String(init!.body)).system).includes("categorize");
      return new Response(JSON.stringify({ content: [{ type: "text", text: categorize ? '["a", "b"]' : "sum" }], usage: { input_tokens: 10, output_tokens: 5 } }));
    };
    const mid = await usageOf();
    await api("POST", `${emailPath()}/${emailId}/ai/summarize`, { token });
    expect(await usageOf()).toEqual([mid[0]! + 2, mid[1]! + 20, mid[2]! + 10]);

    // The connection test counts as a call too.
    const beforeTest = await usageOf();
    await api("POST", `/api/ai/apis/${apiId}/test`, { token });
    expect((await usageOf())[0]).toBe(beforeTest[0]! + 1);

    // An error from the vendor costs nothing here.
    const beforeFail = await usageOf();
    aiHttp.fetch = async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
    await api("POST", "/api/ai/run", { token, body: { category: "grammar", text: "x" } });
    expect(await usageOf()).toEqual(beforeFail);
  });

  test("an AI error is passed on as a 502 with the vendor's message", async () => {
    aiHttp.fetch = async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
    const res = await api("POST", "/api/ai/run", { token, body: { category: "grammar", text: "x" } });
    expect(res.status).toBe(502);
    expect(res.json.error).toContain("invalid x-api-key");
  });

  test("the API test endpoint reports success or the vendor's complaint", async () => {
    fakeAi(() => "OK");
    expect((await api("POST", `/api/ai/apis/${apiId}/test`, { token })).json).toEqual({ ok: true, answer: "OK" });
    aiHttp.fetch = async () => new Response("nope", { status: 500 });
    expect((await api("POST", `/api/ai/apis/${apiId}/test`, { token })).status).toBe(502);
  });

  test("another user can't use, see or change these", async () => {
    await api("POST", "/api/users", { body: { username: "mallory", password: "pw" } });
    const other = (await api("POST", "/api/auth/login", { body: { username: "mallory", password: "pw" } })).json.token;
    expect((await api("GET", "/api/ai/apis", { token: other })).json).toEqual([]);
    expect((await api("PATCH", `/api/ai/apis/${apiId}`, { token: other, body: { model: "x" } })).status).toBe(404);
    expect((await api("POST", `/api/ai/apis/${apiId}/test`, { token: other })).status).toBe(404);
    expect((await api("POST", `${emailPath()}/${emailId}/ai/summarize`, { token: other })).status).toBe(404); // not their account
  });

  test("changing the login password keeps the API key readable", async () => {
    const changed = await api("POST", "/api/auth/change-password", { token, body: { currentPassword: "pw", newPassword: "new-pw" } });
    expect(changed.status).toBe(200);

    const salt = db.query<{ password_salt: string }, [number]>("SELECT password_salt FROM users WHERE id = ?").get(userId)!.password_salt;
    const stored = db.query<{ api_key_encrypted: string }, [number]>("SELECT api_key_encrypted FROM ai_apis WHERE id = ?").get(apiId)!.api_key_encrypted;
    expect(decryptSecret(stored, deriveEncryptionKey("new-pw", salt))).toBe("sk-ant-secret");

    // …and the API still works in the session that changed it.
    const sent = fakeAi(() => "still works");
    expect((await api("POST", "/api/ai/run", { token, body: { category: "grammar", text: "x" } })).json.text).toBe("still works");
    expect(sent).toHaveLength(1);
  });

  test("deleting an API removes its skills", async () => {
    expect((await api("DELETE", `/api/ai/apis/${apiId}`, { token })).status).toBe(204);
    expect((await api("GET", "/api/ai/skills", { token })).json).toEqual([]);
    expect((await api("GET", "/api/ai/apis", { token })).json).toEqual([]);
  });
});

describe("dates and events (the \"events\" skill)", () => {
  let token: string;
  let emailId: number;
  const account = "bea@example.com";
  const summarize = () => api("POST", `/api/accounts/${encodeURIComponent(account)}/emails/${emailId}/ai/summarize`, { token });

  const ANSWER = JSON.stringify([
    { title: "Submit documents", start: "2026-09-30", description: "Send the missing receipts." },
    { title: "Call with Alice", start: "2026-10-02T14:00", end: "2026-10-02T14:30", location: "Phone, +49 2443 911 406" },
    { title: "Broken", start: "next week" },
  ]);

  test("set up: a user with a message, an AI API and a summarize and an events skill", async () => {
    await api("POST", "/api/users", { body: { username: "bea", password: "pw" } });
    token = (await api("POST", "/api/auth/login", { body: { username: "bea", password: "pw" } })).json.token;
    const acc = await api("POST", "/api/accounts", {
      token,
      body: { email: account, imapHost: "h", imapPort: 993, imapUsername: account, imapPassword: "x", smtpHost: "h", smtpPort: 465, smtpUsername: account, smtpPassword: "y" },
    });
    emailId = createEmail(db, acc.json.id, {
      folder: "INBOX", isDraft: false, subject: "Unterlagen", from: [{ name: "Steuerberater", address: "stb@x.com" }],
      date: "2026-09-01T00:00:00.000Z", plainText: "Bitte Unterlagen bis 30.09.2026. Anruf am 2.10. um 14 Uhr.",
    }).id;
    const apiId = (await api("POST", "/api/ai/apis", { token, body: { vendor: "anthropic", model: "claude-opus-5", apiKey: "sk-x" } })).json.id;
    expect((await api("POST", "/api/ai/skills", { token, body: { aiApiId: apiId, category: "summarize", prompt: "You summarize." } })).status).toBe(201);
    expect((await api("POST", "/api/ai/skills", { token, body: { aiApiId: apiId, category: "events", prompt: "You find events. JSON." } })).status).toBe(201);
  });

  test("summarize also looks for dates and events and stores each as its own .ics", async () => {
    const sent = fakeAi(system => (system.includes("find events") ? ANSWER : "- Unterlagen bis 30.09."));
    const res = await summarize();

    expect(res.status).toBe(200);
    expect(sent.map(s => s.system)).toEqual(["You summarize.", "You find events. JSON."]);
    expect(sent[1]!.user).toContain("Date: 2026-09-01"); // the message's date is sent, so relative dates can be resolved

    const events: string[] = res.json.email.calendarEvents;
    expect(events).toHaveLength(2); // the entry without a real date is dropped
    expect(events[0]).toContain("BEGIN:VCALENDAR");
    expect(events[0]).toContain("SUMMARY:Submit documents");
    expect(events[0]).toContain("DTSTART;VALUE=DATE:20260930");
    expect(events[1]).toContain("DTSTART:20261002T140000");
    expect(events[1]).toContain("LOCATION:Phone\\, +49 2443 911 406");
    expect(res.json.eventsError).toBeUndefined();

    // Stored on the message, and back with it.
    expect(getEmail(db, emailId).calendarEvents).toEqual(events);
    expect((await api("GET", `/api/accounts/${encodeURIComponent(account)}/emails/${emailId}`, { token })).json.calendarEvents).toEqual(events);
  });

  test("a message without events stores an empty list; a failing search doesn't lose the summary or the earlier events", async () => {
    fakeAi(system => (system.includes("find events") ? "[]" : "New summary"));
    let res = await summarize();
    expect(res.json.email.aiSummary).toBe("New summary");
    expect(res.json.email.calendarEvents).toEqual([]);

    fakeAi(system => (system.includes("find events") ? ANSWER : "Newest summary"));
    await summarize();
    aiHttp.fetch = async (_url, init) => {
      if (String(JSON.parse(String(init!.body)).system).includes("find events")) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Last summary" }] }));
    };
    res = await summarize();
    expect(res.status).toBe(200);
    expect(res.json.email.aiSummary).toBe("Last summary");
    expect(res.json.eventsError).toContain("overloaded");
    expect(res.json.email.calendarEvents).toHaveLength(2);
  });

  test("the compose endpoint doesn't offer the events category", async () => {
    expect((await api("POST", "/api/ai/run", { token, body: { category: "events", text: "x" } })).status).toBe(400);
  });
});
