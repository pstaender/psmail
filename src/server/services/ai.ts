import { VENDOR_LABELS, type AiCategory } from "../../ai/categories";
import type { AiApiConfig, AiSkillRecord, AiUsage } from "../models/ai";
import { ApiError } from "../types";

/**
 * The HTTP client the AI calls go through — a single object so tests can replace `fetch` for just these
 * calls (replacing the global would also catch the test's own requests to the API server).
 */
export const aiHttp: { fetch: (input: string, init?: RequestInit) => Promise<Response> } = {
  fetch: (input, init) => fetch(input, init),
};

const TIMEOUT_MS = 90_000;
const MAX_INPUT_CHARS = 60_000;

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

  let response: Response;
  try {
    response = await aiHttp.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "it didn't answer in time" : "it couldn't be reached";
    throw new ApiError(502, `${vendorLabel}: ${reason}${api.vendor === "ollama" ? ` (is Ollama running at ${api.baseUrl ?? "http://localhost:11434"}?)` : ""}.`);
  }

  const text = await response.text();
  if (!response.ok) throw new ApiError(502, describeFailure(vendorLabel, response.status, text));

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(502, `${vendorLabel} sent an answer that isn't JSON.`);
  }
  const answer = extract(data);
  if (typeof answer !== "string" || !answer.trim()) throw new ApiError(502, `${vendorLabel} sent an empty answer.`);

  const reported = usageOf(data);
  const count = (value: unknown, fallbackChars: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : Math.ceil(fallbackChars / CHARS_PER_TOKEN);
  return {
    text: answer.trim(),
    usage: { inputTokens: count(reported.input, system.length + input.length), outputTokens: count(reported.output, answer.length) },
  };
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
  let labels: unknown[] = [];
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(answer.slice(start, end + 1));
      if (Array.isArray(parsed)) labels = parsed;
    } catch {
      // fall through to the loose parse
    }
  }
  if (labels.length === 0) labels = answer.split(/[\n,;]+/);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const label = raw.replace(/^[\s\-*•\d.)]+/, "").replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, 40);
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
