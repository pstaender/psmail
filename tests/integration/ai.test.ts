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
    expect(made.json).toMatchObject({ vendor: "anthropic", hasKey: true });
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
    expect(second.json).toMatchObject({ name: "Formal", label: "Formal" });
    const list = (await api("GET", "/api/ai/skills", { token })).json as { id: number; category: string; label: string }[];
    expect(list.find(s => s.category === "summarize")!.label).toBe("Anthropic.claude-opus-5"); // created without a name

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
