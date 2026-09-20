import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsCache, updateSettings } from "../../src/server/config/settings";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { decryptSecret, deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import {
  createAiApi,
  createAiSkill,
  deleteAiApi,
  findSkillForCategory,
  getAiApiConfig,
  listAiApis,
  listAiSkills,
  recordAiUsage,
  updateAiApi,
  updateAiSkill,
} from "../../src/server/models/ai";
import { parseJsonArray } from "../../src/server/services/jsonAnswer";
import { parseEventsAnswer } from "../../src/server/services/ics";
import { aiHttp, aiLog, complete, emailTextForAi, parseTaxonomy, renderPrompt } from "../../src/server/services/ai";
import { SKILL_DEFAULTS, AI_CATEGORIES, defaultApiLabel } from "../../src/ai/categories";

const key = deriveEncryptionKey("pw", generateSalt());

async function setup() {
  const db = createTestDb();
  const user = await createUser(db, "alice", "pw");
  return { db, user };
}

describe("skill defaults", () => {
  test("there is a suggested prompt for every category, and the translate one asks for a language", () => {
    for (const category of AI_CATEGORIES) {
      expect(SKILL_DEFAULTS[category].prompt.length).toBeGreaterThan(50);
      expect(SKILL_DEFAULTS[category].label).toBeTruthy();
    }
    expect(SKILL_DEFAULTS.translate.prompt).toContain("{{language}}");
    expect(SKILL_DEFAULTS.categorize.prompt).toContain("JSON array");
  });
});

describe("AI APIs", () => {
  test("the key is stored encrypted, never returned, and only opened for a call", async () => {
    const { db, user } = await setup();
    const api = createAiApi(db, user.id, { vendor: "anthropic", model: "claude-opus-5", apiKey: "sk-secret" }, key);

    expect(api).toMatchObject({ vendor: "anthropic", model: "claude-opus-5", hasKey: true, name: "", label: "Anthropic.claude-opus-5", baseUrl: null });
    expect(JSON.stringify(api)).not.toContain("sk-secret");
    const stored = db.query<{ api_key_encrypted: string }, []>("SELECT api_key_encrypted FROM ai_apis").get()!.api_key_encrypted;
    expect(stored).not.toContain("sk-secret");
    expect(decryptSecret(stored, key)).toBe("sk-secret");
    expect(getAiApiConfig(db, user.id, api.id, key)).toEqual({ id: api.id, vendor: "anthropic", model: "claude-opus-5", baseUrl: null, apiKey: "sk-secret" });
  });

  test("validates vendor, model, key (not needed for Ollama) and address", async () => {
    const { db, user } = await setup();
    expect(() => createAiApi(db, user.id, { vendor: "skynet", model: "x", apiKey: "k" }, key)).toThrow(/vendor/);
    expect(() => createAiApi(db, user.id, { vendor: "openai", model: " ", apiKey: "k" }, key)).toThrow(/model/);
    expect(() => createAiApi(db, user.id, { vendor: "openai", model: "gpt", apiKey: "" }, key)).toThrow(/needs an API key/);
    expect(() => createAiApi(db, user.id, { vendor: "ollama", model: "llama3", baseUrl: "ftp://x" }, key)).toThrow(/http/);
    expect(() => createAiApi(db, user.id, { vendor: "ollama", model: "llama3", baseUrl: "not a url" }, key)).toThrow(/URL/);

    const ollama = createAiApi(db, user.id, { vendor: "ollama", model: "llama3", baseUrl: "http://localhost:11434/" }, key);
    expect(ollama).toMatchObject({ hasKey: false, baseUrl: "http://localhost:11434" });
  });

  test("updating keeps the stored key unless a new one is given", async () => {
    const { db, user } = await setup();
    const api = createAiApi(db, user.id, { vendor: "openai", model: "gpt-a", apiKey: "old-key" }, key);

    updateAiApi(db, user.id, api.id, { model: "gpt-b", name: "Work GPT" }, key);
    expect(getAiApiConfig(db, user.id, api.id, key)).toMatchObject({ model: "gpt-b", apiKey: "old-key" });
    expect(listAiApis(db, user.id)[0]!.label).toBe("Work GPT");

    updateAiApi(db, user.id, api.id, { apiKey: "new-key" }, key);
    expect(getAiApiConfig(db, user.id, api.id, key).apiKey).toBe("new-key");
    expect(() => updateAiApi(db, user.id, api.id, { apiKey: null }, key)).toThrow(/needs an API key/);
  });

  test("a provider's label is its name, or Vendor.model when it has none — also after editing, and it follows the model", async () => {
    const { db, user } = await setup();
    const api = createAiApi(db, user.id, { vendor: "anthropic", model: "claude-opus-5", apiKey: "k" }, key);
    expect(api).toMatchObject({ name: "", label: "Anthropic.claude-opus-5" });

    expect(updateAiApi(db, user.id, api.id, { name: "Work Claude" }, key).label).toBe("Work Claude");
    expect(updateAiApi(db, user.id, api.id, { name: "  " }, key)).toMatchObject({ name: "", label: "Anthropic.claude-opus-5" }); // cleared again
    expect(updateAiApi(db, user.id, api.id, { model: "claude-sonnet-5" }, key).label).toBe("Anthropic.claude-sonnet-5");
    expect(listAiApis(db, user.id)[0]!.label).toBe("Anthropic.claude-sonnet-5");

    expect(defaultApiLabel("openai", "gpt-5")).toBe("OpenAI.gpt-5");
    expect(defaultApiLabel("google", "gemini-2.5-pro")).toBe("Google.gemini-2.5-pro");
    expect(defaultApiLabel("ollama", "llama3")).toBe("Ollama.llama3");
  });

  test("usage is added up on the provider's record, survives edits, and stays per provider", async () => {
    const { db, user } = await setup();
    const a = createAiApi(db, user.id, { vendor: "openai", model: "gpt", apiKey: "k" }, key);
    const b = createAiApi(db, user.id, { vendor: "ollama", model: "llama3" }, key);
    expect(a).toMatchObject({ calls: 0, inputTokens: 0, outputTokens: 0 });

    recordAiUsage(db, a.id, { inputTokens: 100, outputTokens: 20 });
    recordAiUsage(db, a.id, { inputTokens: 50, outputTokens: 5 });
    recordAiUsage(db, b.id, { inputTokens: 7, outputTokens: 3 });

    const list = listAiApis(db, user.id);
    expect(list.map(x => [x.calls, x.inputTokens, x.outputTokens])).toEqual([[2, 150, 25], [1, 7, 3]]);

    // Editing the provider keeps its totals.
    updateAiApi(db, user.id, a.id, { model: "gpt-b", name: "Renamed" }, key);
    expect(listAiApis(db, user.id)[0]).toMatchObject({ calls: 2, inputTokens: 150, outputTokens: 25 });
    // Nonsense (negative/fractional) never makes a total go down.
    recordAiUsage(db, a.id, { inputTokens: -5, outputTokens: 2.6 });
    expect(listAiApis(db, user.id)[0]).toMatchObject({ calls: 3, inputTokens: 150, outputTokens: 28 });
  });

  test("users only see and touch their own", async () => {
    const { db, user } = await setup();
    const bob = await createUser(db, "bob", "pw");
    const api = createAiApi(db, user.id, { vendor: "openai", model: "gpt", apiKey: "k" }, key);

    expect(listAiApis(db, bob.id)).toEqual([]);
    expect(() => updateAiApi(db, bob.id, api.id, { model: "x" }, key)).toThrow(/not found/);
    expect(() => deleteAiApi(db, bob.id, api.id)).toThrow(/not found/);
    expect(() => getAiApiConfig(db, bob.id, api.id, key)).toThrow(/not found/);
    expect(() => createAiSkill(db, bob.id, { aiApiId: api.id, category: "translate", prompt: "p" })).toThrow(/not found/);
  });
});

describe("AI skills", () => {
  test("a skill belongs to one API; deleting the API deletes its skills", async () => {
    const { db, user } = await setup();
    const a = createAiApi(db, user.id, { vendor: "openai", model: "gpt", apiKey: "k" }, key);
    const b = createAiApi(db, user.id, { vendor: "ollama", model: "llama3" }, key);
    createAiSkill(db, user.id, { aiApiId: a.id, category: "summarize", name: "Sum", prompt: "Summarize." });
    createAiSkill(db, user.id, { aiApiId: b.id, category: "translate", prompt: "Translate to {{language}}." });

    expect(listAiSkills(db, user.id).map(s => [s.category, s.name, s.aiApiId])).toEqual([
      ["summarize", "Sum", a.id],
      ["translate", "translate", b.id], // no name given: the category
    ]);
    deleteAiApi(db, user.id, a.id);
    expect(listAiSkills(db, user.id).map(s => s.category)).toEqual(["translate"]);
  });

  test("validates category and prompt, and can be edited", async () => {
    const { db, user } = await setup();
    const api = createAiApi(db, user.id, { vendor: "ollama", model: "llama3" }, key);
    expect(() => createAiSkill(db, user.id, { aiApiId: api.id, category: "dance", prompt: "p" })).toThrow(/category/);
    expect(() => createAiSkill(db, user.id, { aiApiId: api.id, category: "grammar", prompt: "  " })).toThrow(/prompt is required/);
    expect(() => createAiSkill(db, user.id, { aiApiId: api.id, category: "grammar", prompt: "x".repeat(8001) })).toThrow(/too long/);

    const skill = createAiSkill(db, user.id, { aiApiId: api.id, category: "grammar", prompt: "Fix it." });
    const updated = updateAiSkill(db, user.id, skill.id, { prompt: "Fix it better.", name: "Proofread" });
    expect(updated).toMatchObject({ prompt: "Fix it better.", name: "Proofread", category: "grammar" });
  });

  test("a skill without a name is called after its category, and can't be renamed to nothing", async () => {
    const { db, user } = await setup();
    const api = createAiApi(db, user.id, { vendor: "anthropic", model: "claude-opus-5", apiKey: "k" }, key);
    const skill = createAiSkill(db, user.id, { aiApiId: api.id, category: "summarize", prompt: "p" });
    expect(skill.name).toBe("summarize");
    expect(updateAiSkill(db, user.id, skill.id, { name: "Short" }).name).toBe("Short");
    expect(updateAiSkill(db, user.id, skill.id, { name: "  " }).name).toBe("Short"); // blank keeps the old one
  });

  test("a specific skill can be asked for, as long as it is the user's and of that category", async () => {
    const { db, user } = await setup();
    const bob = await createUser(db, "bob", "pw");
    const api = createAiApi(db, user.id, { vendor: "ollama", model: "llama3" }, key);
    const bobsApi = createAiApi(db, bob.id, { vendor: "ollama", model: "llama3" }, key);
    const first = createAiSkill(db, user.id, { aiApiId: api.id, category: "translate", prompt: "one" });
    const second = createAiSkill(db, user.id, { aiApiId: api.id, category: "translate", prompt: "two" });
    const summarizer = createAiSkill(db, user.id, { aiApiId: api.id, category: "summarize", prompt: "s" });
    const bobs = createAiSkill(db, bob.id, { aiApiId: bobsApi.id, category: "translate", prompt: "bob" });

    expect(findSkillForCategory(db, user.id, "translate")!.id).toBe(first.id);
    expect(findSkillForCategory(db, user.id, "translate", second.id)!.id).toBe(second.id);
    expect(() => findSkillForCategory(db, user.id, "translate", summarizer.id)).toThrow(/isn't a translate skill/);
    expect(() => findSkillForCategory(db, user.id, "translate", bobs.id)).toThrow(/not found/);
  });

  test("the skill used for a category is the user's first one", async () => {
    const { db, user } = await setup();
    const api = createAiApi(db, user.id, { vendor: "ollama", model: "llama3" }, key);
    expect(findSkillForCategory(db, user.id, "summarize")).toBeNull();
    const first = createAiSkill(db, user.id, { aiApiId: api.id, category: "summarize", prompt: "one" });
    createAiSkill(db, user.id, { aiApiId: api.id, category: "summarize", prompt: "two" });
    expect(findSkillForCategory(db, user.id, "summarize")!.id).toBe(first.id);
  });
});

describe("talking to the vendors", () => {
  const original = aiHttp.fetch;
  afterEach(() => {
    aiHttp.fetch = original;
  });
  function stub(answer: unknown, status = 200) {
    const calls: { url: string; init: RequestInit; body: any }[] = [];
    aiHttp.fetch = async (url, init) => {
      calls.push({ url, init: init!, body: JSON.parse(String(init!.body)) });
      return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status });
    };
    return calls;
  }

  test("Anthropic: messages API with the key header, system prompt and user text", async () => {
    const calls = stub({ content: [{ type: "text", text: "Hello" }, { type: "text", text: " world" }] });
    const answer = await complete({ id: 1, vendor: "anthropic", model: "claude-opus-5", baseUrl: null, apiKey: "sk-a" }, "SYS", "USER");

    expect(answer.text).toBe("Hello world");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-a");
    expect(calls[0]!.body).toMatchObject({ model: "claude-opus-5", system: "SYS", messages: [{ role: "user", content: "USER" }] });
  });

  test("OpenAI (and compatible services via the address): chat completions with a bearer token", async () => {
    const calls = stub({ choices: [{ message: { content: "Hi" } }] });
    expect((await complete({ id: 1, vendor: "openai", model: "gpt-x", baseUrl: "https://llm.example.com/v1", apiKey: "sk-o" }, "SYS", "USER")).text).toBe("Hi");
    expect(calls[0]!.url).toBe("https://llm.example.com/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-o");
    expect(calls[0]!.body.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]);
  });

  test("Google: generateContent with the model in the path and the key in a header", async () => {
    const calls = stub({ candidates: [{ content: { parts: [{ text: "Gem" }, { text: "ini" }] } }] });
    expect((await complete({ id: 1, vendor: "google", model: "gemini-2.5-pro", baseUrl: null, apiKey: "g-key" }, "SYS", "USER")).text).toBe("Gemini");
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
    expect(calls[0]!.body).toMatchObject({ systemInstruction: { parts: [{ text: "SYS" }] }, contents: [{ role: "user", parts: [{ text: "USER" }] }] });
  });

  test("Ollama: a local chat call, no key, not streamed", async () => {
    const calls = stub({ message: { content: "Llama says hi" } });
    expect((await complete({ id: 1, vendor: "ollama", model: "llama3", baseUrl: null, apiKey: null }, "SYS", "USER")).text).toBe("Llama says hi");
    expect(calls[0]!.url).toBe("http://localhost:11434/api/chat");
    expect(calls[0]!.body).toMatchObject({ model: "llama3", stream: false });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("token usage is read from each vendor's answer", async () => {
    stub({ content: [{ type: "text", text: "x" }], usage: { input_tokens: 120, output_tokens: 30 } });
    expect((await complete({ id: 1, vendor: "anthropic", model: "m", baseUrl: null, apiKey: "k" }, "s", "u")).usage).toEqual({ inputTokens: 120, outputTokens: 30 });

    stub({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    expect((await complete({ id: 1, vendor: "openai", model: "m", baseUrl: null, apiKey: "k" }, "s", "u")).usage).toEqual({ inputTokens: 11, outputTokens: 7 });

    stub({ candidates: [{ content: { parts: [{ text: "x" }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } });
    expect((await complete({ id: 1, vendor: "google", model: "m", baseUrl: null, apiKey: "k" }, "s", "u")).usage).toEqual({ inputTokens: 5, outputTokens: 2 });

    stub({ message: { content: "x" }, prompt_eval_count: 42, eval_count: 9 });
    expect((await complete({ id: 1, vendor: "ollama", model: "m", baseUrl: null, apiKey: null }, "s", "u")).usage).toEqual({ inputTokens: 42, outputTokens: 9 });
  });

  test("without a usage report the tokens are estimated at about 4 characters each", async () => {
    stub({ choices: [{ message: { content: "y".repeat(40) } }] }); // no usage field (some compatible services)
    const result = await complete({ id: 1, vendor: "openai", model: "m", baseUrl: null, apiKey: "k" }, "s".repeat(20), "u".repeat(60));
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 }); // (20+60)/4 and 40/4
  });

  test("failures become readable errors: the vendor's message, unreachable servers, empty answers", async () => {
    stub({ error: { message: "invalid x-api-key" } }, 401);
    await expect(complete({ id: 1, vendor: "anthropic", model: "m", baseUrl: null, apiKey: "bad" }, "s", "u")).rejects.toThrow(/Anthropic answered with an error \(401\): invalid x-api-key/);

    aiHttp.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(complete({ id: 1, vendor: "ollama", model: "m", baseUrl: null, apiKey: null }, "s", "u")).rejects.toThrow(/Ollama \(local\): it couldn't be reached \(is Ollama running/);

    stub({ choices: [{ message: { content: "  " } }] });
    await expect(complete({ id: 1, vendor: "openai", model: "m", baseUrl: null, apiKey: "k" }, "s", "u")).rejects.toThrow(/empty answer/);
  });

  test("a very long text is cut before it is sent", async () => {
    const calls = stub({ choices: [{ message: { content: "ok" } }] });
    await complete({ id: 1, vendor: "openai", model: "m", baseUrl: null, apiKey: "k" }, "s", "x".repeat(200_000));
    expect(calls[0]!.body.messages[1].content.length).toBe(60_000);
  });
});

describe("helpers", () => {
  test("renderPrompt fills the language placeholder", () => {
    expect(renderPrompt("Translate into {{language}}. Answer in {{language}}.", "German")).toBe("Translate into German. Answer in German.");
  });

  test("parseTaxonomy takes a JSON array, tolerates prose around it or a plain list, and keeps 2-6 unique short labels", () => {
    expect(parseTaxonomy('["invoice", "action needed"]')).toEqual(["invoice", "action needed"]);
    expect(parseTaxonomy('Sure! Here you go:\n```json\n["Travel", "travel", "flights"]\n```')).toEqual(["Travel", "flights"]);
    expect(parseTaxonomy("- invoice\n- meeting\n* newsletter")).toEqual(["invoice", "meeting", "newsletter"]);
    expect(parseTaxonomy("a, b, c, d, e, f, g, h")).toHaveLength(6);
    expect(parseTaxonomy('["' + "y".repeat(100) + '"]')[0]!.length).toBe(40);
    expect(parseTaxonomy("")).toEqual([]);
  });

  test("emailTextForAi heads the body with subject, sender and date, and falls back to stripped HTML", () => {
    const base = { subject: "Hi", from: [{ name: "Alice", address: "a@x.com" }], date: "2026-01-01T00:00:00.000Z" };
    expect(emailTextForAi({ ...base, plainText: "Body", htmlText: "<p>ignored</p>" })).toBe(
      "Subject: Hi\nFrom: Alice <a@x.com>\nDate: 2026-01-01T00:00:00.000Z\n\nBody"
    );
    const fromHtml = emailTextForAi({ ...base, plainText: null, htmlText: "<style>p{}</style><p>Hello&nbsp;<b>you</b> &amp; co</p><p>Bye</p>" });
    expect(fromHtml).toContain("Hello you & co");
    expect(fromHtml).toContain("Bye");
    expect(fromHtml.split("\n\n").slice(1).join("\n\n")).not.toContain("<"); // no tags left in the body
  });
});


describe("verbose AI logging (verboseAiApiCalls in settings.json)", () => {
  const originalFetch = aiHttp.fetch;
  const originalWrite = aiLog.write;
  const originalDir = process.env.PSMAIL_CONFIG_DIR;
  let dir = "";
  let lines: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "psmail-verbose-ai-"));
    process.env.PSMAIL_CONFIG_DIR = dir;
    resetSettingsCache();
    lines = [];
    aiLog.write = line => lines.push(line);
  });
  afterEach(() => {
    aiHttp.fetch = originalFetch;
    aiLog.write = originalWrite;
    if (originalDir === undefined) delete process.env.PSMAIL_CONFIG_DIR;
    else process.env.PSMAIL_CONFIG_DIR = originalDir;
    resetSettingsCache();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = { id: 1, vendor: "anthropic", model: "claude-opus-5", baseUrl: null, apiKey: "sk-secret-key" } as const;
  const answers = (data: unknown, status = 200) => {
    aiHttp.fetch = async () => new Response(typeof data === "string" ? data : JSON.stringify(data), { status });
  };
  const ok = { content: [{ type: "text", text: "The summary" }], usage: { input_tokens: 120, output_tokens: 9 } };

  test("off by default: nothing is logged", async () => {
    await updateSettings({}); // a settings.json without the option
    answers(ok);
    await complete(api, "SYSTEM PROMPT", "USER TEXT");
    expect(lines).toEqual([]);
  });

  test("on: the request, the answer, the time and the tokens are logged — and never the API key", async () => {
    await updateSettings({ verboseAiApiCalls: true });
    answers(ok);
    await complete(api, "SYSTEM PROMPT", "USER TEXT");

    const log = lines.join("\n");
    expect(log).toContain("[ai] → anthropic claude-opus-5  POST https://api.anthropic.com/v1/messages");
    expect(log).toContain("SYSTEM PROMPT");
    expect(log).toContain("USER TEXT");
    expect(log).toMatch(/\[ai\] ← anthropic claude-opus-5  HTTP 200 in \d+ ms · 120 tokens in, 9 out\n?/);
    expect(log).not.toContain("(estimated)");
    expect(log).toContain("The summary");
    expect(log).not.toContain("sk-secret-key");
  });

  test("tokens the vendor didn't report are marked as estimated", async () => {
    await updateSettings({ verboseAiApiCalls: true });
    answers({ content: [{ type: "text", text: "Answer" }] });
    await complete(api, "S", "U");
    expect(lines.join("\n")).toContain("(estimated)");
  });

  test("failures are logged with what the service said", async () => {
    await updateSettings({ verboseAiApiCalls: true });
    answers({ error: { message: "rate limited" } }, 429);
    await expect(complete(api, "S", "U")).rejects.toThrow("rate limited");
    expect(lines.join("\n")).toContain("[ai] ✗ anthropic claude-opus-5  HTTP 429");
    expect(lines.join("\n")).toContain("rate limited");

    lines.length = 0;
    aiHttp.fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(complete(api, "S", "U")).rejects.toThrow("couldn't be reached");
    expect(lines.join("\n")).toContain("no answer after");
    expect(lines.join("\n")).toContain("ECONNREFUSED");

    lines.length = 0;
    answers("<html>not json</html>");
    await expect(complete(api, "S", "U")).rejects.toThrow("isn't JSON");
    expect(lines.join("\n")).toContain("the answer isn't JSON");
  });

  test("very long texts are cut in the log (with how much), but not in the call", async () => {
    await updateSettings({ verboseAiApiCalls: true });
    let sent = "";
    aiHttp.fetch = async (_url, init) => {
      sent = JSON.parse(String(init!.body)).messages[0].content;
      return new Response(JSON.stringify(ok));
    };
    await complete(api, "S", "x".repeat(10_000));
    expect(sent.length).toBe(10_000);
    expect(lines.join("\n")).toContain("… (6000 more characters)");
  });
});

describe("JSON arrays with typographic quotes", () => {
  test("the categories from the report — written with “ ” — are read", () => {
    expect(parseTaxonomy("[“veranstaltung”, “weiterleitung”, “einladung”, “musik”, “privat”]")).toEqual([
      "veranstaltung",
      "weiterleitung",
      "einladung",
      "musik",
      "privat",
    ]);
  });

  test("other quote styles are read too: „ “, « », single quotes, ‘ ’, and inside prose or a code fence", () => {
    const expected = ["a", "b"];
    for (const answer of ["[„a“, „b“]", "[«a», «b»]", "['a', 'b']", "[‘a’, ‘b’]", "Sure: [“a”, “b”] Done.", "```json\n[“a”, “b”]\n```", '["a", “b”]']) {
      expect(parseTaxonomy(answer)).toEqual(expected);
    }
  });

  test("valid JSON is parsed as it is: typographic quotes inside a proper string stay", () => {
    expect(parseJsonArray('["say “hi”", "b"]')).toEqual(["say “hi”", "b"]);
  });

  test("labels that had to be split out loosely lose typographic quotes at their ends", () => {
    expect(parseTaxonomy("“invoice”, ‘travel’, „action“")).toEqual(["invoice", "travel", "action"]);
  });

  test("parseJsonArray: an array or null", () => {
    expect(parseJsonArray("no array here")).toBeNull();
    expect(parseJsonArray("[oops")).toBeNull();
    expect(parseJsonArray("[1, 2")).toBeNull();
    expect(parseJsonArray("[]")).toEqual([]);
    expect(parseJsonArray('[{“title”: “A”, “start”: “2026-09-30”}]')).toEqual([{ title: "A", start: "2026-09-30" }]);
  });

  test("events written with typographic quotes are found as well", () => {
    expect(parseEventsAnswer('[{“title”: “Abgabe”, “start”: “2026-09-30”, “location”: “Büro”}]')).toEqual([
      { title: "Abgabe", start: "2026-09-30", location: "Büro" },
    ]);
  });
});
