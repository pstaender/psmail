import { DEFAULT_ADDRESSES, VENDOR_LABELS, type AiCategory, type AiVendor } from "../../ai/categories";
import type { AiApiConfig, AiSkillRecord, AiUsage } from "../models/ai";
import { peekSettings } from "../config/settings";
import { ANY_QUOTES_AT_ENDS, parseJsonArray } from "./jsonAnswer";
import { ApiError } from "../types";

/**
 * The HTTP client the AI calls go through — a single object so tests can replace `fetch` for just these
 * calls (replacing the global would also catch the test's own requests to the API server).
 */
export const aiHttp: { fetch: (input: string, init?: RequestInit) => Promise<Response> } = {
  fetch: (input, init) => fetch(input, init),
};

/** Where verbose AI logging goes (the server's console) — replaceable so tests can read it. */
export const aiLog: { write: (line: string) => void } = { write: line => console.log(line) };

/** With `verboseAiApiCalls: true` in settings.json every AI call is written to the console; the API key never is. */
const verbose = () => peekSettings()?.verboseAiApiCalls === true;

/** A long text cut to what a console can carry, saying how much was left out. */
function clip(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

/** Indents a (possibly multi-line) text under a log line. */
function block(label: string, text: string): string {
  return `[ai]   ${label}:\n${clip(text).split("\n").map(line => `[ai]     ${line}`).join("\n")}`;
}

const TIMEOUT_MS = 90_000;
const MAX_INPUT_CHARS = 60_000;

/**
 * The base URL of an OpenAI-compatible server, as the API paths are appended to it: the address as given without a trailing slash,
 * and `/v1` added when only a host was given (people type http://localhost:1234 and mean LM Studio's http://localhost:1234/v1).
 */
export function compatibleBase(address: string | null | undefined): string {
  const given = (address?.trim() || DEFAULT_ADDRESSES["openai-compatible"]!).replace(/\/+$/, "");
  try {
    return new URL(given).pathname.replace(/\/+$/, "") === "" ? `${given}/v1` : given;
  } catch {
    return given;
  }
}

/** Reasoning models that put their thinking in the answer itself (<think>…</think>) — the reasoning is not part of the answer. */
export function withoutThinking(content: unknown): unknown {
  return typeof content === "string" ? content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "") : content;
}

/** "(is Ollama running at …?)" — what to check when a server on this machine doesn't answer. */
function localServerHint(vendor: AiVendor, address: string | null): string {
  if (vendor === "ollama") return ` (is Ollama running at ${address ?? DEFAULT_ADDRESSES.ollama}?)`;
  if (vendor === "openai-compatible") return ` (is the server running at ${compatibleBase(address)}, with a model loaded?)`;
  return "";
}

/**
 * The models a server offers, for the model field: an OpenAI-compatible server lists them at `<address>/models`, Ollama at
 * `/api/tags`. Other vendors have no such list here. Never throws for an unreachable server's sake — the caller decides what to say.
 */
export async function listModels(vendor: AiVendor, address: string | null, apiKey: string | null): Promise<string[]> {
  if (vendor !== "openai-compatible" && vendor !== "ollama") throw new ApiError(400, `Models can be listed for ${VENDOR_LABELS.ollama} and ${VENDOR_LABELS["openai-compatible"]}`);
  const url = vendor === "ollama" ? `${(address ?? DEFAULT_ADDRESSES.ollama!).replace(/\/+$/, "")}/api/tags` : `${compatibleBase(address)}/models`;
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  let response: Response;
  try {
    response = await aiHttp.fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ApiError(502, `${VENDOR_LABELS[vendor]}: it couldn't be reached at ${url}.`);
  }
  if (!response.ok) throw new ApiError(502, `${VENDOR_LABELS[vendor]} answered with an error (${response.status}) for its model list.`);
  const data = (await response.json().catch(() => null)) as { data?: { id?: unknown }[]; models?: { name?: unknown }[] } | null;
  const names = vendor === "ollama" ? (data?.models ?? []).map(m => m.name) : (data?.data ?? []).map(m => m.id);
  return names.filter((name): name is string => typeof name === "string" && name !== "");
}

/** How much of the API's complaint to pass on to the user. */
function describeFailure(vendor: string, status: number, body: string): string {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message ?? (typeof parsed?.error === "string" ? parsed.error : undefined) ?? parsed?.message ?? message;
  } catch {
    // not JSON — use the text as is
  }
  return `${vendor} answered with an error (${status}): ${String(message).slice(0, 300)}`;
}

/**
 * Sends `system` + `user` to the configured AI service and returns its text answer. One adapter per vendor;
 * every one of them is a single non-streaming request. The mail text leaves this server for that service,
 * which is why nothing here runs unless the user set up an API and pressed a button for it.
 */
export interface AiResult {
  text: string;
  /** Tokens the call used: as the vendor reports them, else an estimate (~4 characters per token). */
  usage: AiUsage;
}

const CHARS_PER_TOKEN = 4;

export async function complete(api: AiApiConfig, system: string, user: string): Promise<AiResult> {
  const vendorLabel = VENDOR_LABELS[api.vendor];
  const input = user.length > MAX_INPUT_CHARS ? user.slice(0, MAX_INPUT_CHARS) : user;

  let url: string;
  let headers: Record<string, string> = { "content-type": "application/json" };
  let body: unknown;
  let extract: (data: any) => unknown;
  // The vendor's own token counts, when its answer has them.
  let usageOf: (data: any) => { input?: unknown; output?: unknown } = () => ({});

  switch (api.vendor) {
    case "anthropic":
      url = `${api.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
      headers = { ...headers, "x-api-key": api.apiKey ?? "", "anthropic-version": "2023-06-01" };
      body = { model: api.model, max_tokens: 4096, system, messages: [{ role: "user", content: input }] };
      extract = data => (data?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
      usageOf = data => ({ input: data?.usage?.input_tokens, output: data?.usage?.output_tokens });
      break;
    case "openai":
      url = `${api.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
      headers = { ...headers, authorization: `Bearer ${api.apiKey ?? ""}` };
      body = { model: api.model, messages: [{ role: "system", content: system }, { role: "user", content: input }] };
      extract = data => data?.choices?.[0]?.message?.content;
      usageOf = data => ({ input: data?.usage?.prompt_tokens, output: data?.usage?.completion_tokens });
      break;
    case "openai-compatible":
      // Any server that speaks the OpenAI chat-completions API. It needs no key unless it wants one; the address decides where.
      url = `${compatibleBase(api.baseUrl)}/chat/completions`;
      if (api.apiKey) headers = { ...headers, authorization: `Bearer ${api.apiKey}` };
      body = { model: api.model, messages: [{ role: "system", content: system }, { role: "user", content: input }] };
      extract = data => withoutThinking(data?.choices?.[0]?.message?.content);
      usageOf = data => ({ input: data?.usage?.prompt_tokens, output: data?.usage?.completion_tokens });
      break;
    case "google":
      url = `${api.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${encodeURIComponent(api.model)}:generateContent`;
      headers = { ...headers, "x-goog-api-key": api.apiKey ?? "" };
      body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: input }] }] };
      extract = data => (data?.candidates?.[0]?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? "").join("");
      usageOf = data => ({ input: data?.usageMetadata?.promptTokenCount, output: data?.usageMetadata?.candidatesTokenCount });
      break;
    case "ollama":
      url = `${api.baseUrl ?? "http://localhost:11434"}/api/chat`;
      body = { model: api.model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: input }] };
      extract = data => data?.message?.content;
      usageOf = data => ({ input: data?.prompt_eval_count, output: data?.eval_count });
      break;
  }

  const started = Date.now();
  const log = verbose();
  const callId = `${api.vendor} ${api.model}`;
  if (log) {
    aiLog.write(`[ai] → ${callId}  POST ${url}  (system prompt ${system.length} characters, input ${input.length}${input.length < user.length ? ` of ${user.length}, cut` : ""})`);
    aiLog.write(block("system prompt", system));
    aiLog.write(block("input", input));
  }

  let response: Response;
  try {
    response = await aiHttp.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    if (log) aiLog.write(`[ai] ✗ ${callId}  no answer after ${Date.now() - started} ms: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    const reason = error instanceof Error && error.name === "TimeoutError" ? "it didn't answer in time" : "it couldn't be reached";
    throw new ApiError(502, `${vendorLabel}: ${reason}${localServerHint(api.vendor, api.baseUrl)}.`);
  }

  const text = await response.text();
  if (!response.ok) {
    if (log) aiLog.write(`[ai] ✗ ${callId}  HTTP ${response.status} after ${Date.now() - started} ms\n${block("response", text)}`);
    throw new ApiError(502, describeFailure(vendorLabel, response.status, text));
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (log) aiLog.write(`[ai] ✗ ${callId}  the answer isn't JSON (after ${Date.now() - started} ms)\n${block("response", text)}`);
    throw new ApiError(502, `${vendorLabel} sent an answer that isn't JSON.`);
  }
  const answer = extract(data);
  if (log && (typeof answer !== "string" || !answer.trim())) aiLog.write(`[ai] ✗ ${callId}  an empty answer (after ${Date.now() - started} ms)\n${block("response", text)}`);
  if (typeof answer !== "string" || !answer.trim()) throw new ApiError(502, `${vendorLabel} sent an empty answer.`);

  const reported = usageOf(data);
  const count = (value: unknown, fallbackChars: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : Math.ceil(fallbackChars / CHARS_PER_TOKEN);
  const usage = { inputTokens: count(reported.input, system.length + input.length), outputTokens: count(reported.output, answer.length) };
  if (log) {
    const estimated = typeof reported.input === "number" && typeof reported.output === "number" ? "" : " (estimated)";
    aiLog.write(`[ai] ← ${callId}  HTTP ${response.status} in ${Date.now() - started} ms · ${usage.inputTokens} tokens in, ${usage.outputTokens} out${estimated}`);
    aiLog.write(block("answer", answer.trim()));
  }
  return { text: answer.trim(), usage };
}

/** Fills a skill's prompt placeholders. */
export function renderPrompt(prompt: string, language: string): string {
  return prompt.replaceAll("{{language}}", language);
}

/** Runs a skill's prompt over `text` on the API it belongs to. */
export async function runSkill(skill: AiSkillRecord, api: AiApiConfig, text: string, language: string): Promise<AiResult> {
  return complete(api, renderPrompt(skill.prompt, language), text);
}

/**
 * Turns a categorize answer into 2-6 short labels: a JSON array if the model followed the prompt,
 * otherwise (a model that added prose, or answered as a list) whatever comma/line-separated labels are in it.
 */
export function parseTaxonomy(answer: string): string[] {
  let labels: unknown[] = parseJsonArray(answer) ?? [];
  if (labels.length === 0) labels = answer.split(/[\n,;]+/); // not usable JSON: whatever comma/line-separated labels there are

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const label = raw.replace(/^[\s\-*•\d.)]+/, "").replace(ANY_QUOTES_AT_ENDS, "").trim().slice(0, 40);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    result.push(label);
    if (result.length === 6) break;
  }
  return result;
}

/** Plain text of a message for the AI: the plain part, else the HTML with tags stripped; headed by who/what/when. */
export function emailTextForAi(email: { subject: string | null; from: { name?: string; address: string }[]; date: string | null; plainText: string | null; htmlText: string | null }): string {
  let body = email.plainText ?? "";
  if (!body.trim() && email.htmlText) {
    body = email.htmlText
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n");
  }
  const from = email.from[0] ? (email.from[0].name ? `${email.from[0].name} <${email.from[0].address}>` : email.from[0].address) : "unknown";
  return `Subject: ${email.subject ?? ""}\nFrom: ${from}\nDate: ${email.date ?? ""}\n\n${body.trim()}`;
}

export type { AiCategory };
