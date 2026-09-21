import defaults from "./skillDefaults.json";

/** The kinds of AI skill, in display order. The suggested prompts live in skillDefaults.json. */
export const AI_CATEGORIES = ["summarize", "categorize", "events", "translate", "grammar", "improve"] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];

export interface SkillDefault {
  label: string;
  description: string;
  prompt: string;
}

export const SKILL_DEFAULTS = defaults.categories as Record<AiCategory, SkillDefault>;

export function isAiCategory(value: unknown): value is AiCategory {
  return typeof value === "string" && (AI_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Vendors the app can talk to. `openai-compatible` is any server that speaks the OpenAI chat-completions API — LM Studio, vLLM,
 * llama.cpp's server, LocalAI, OpenRouter, ... — at an address you give it (LM Studio's own default is http://localhost:1234/v1).
 * Servers running on your own machine — `ollama` and `openai-compatible` — don't need a key; the others do.
 */
export const AI_VENDORS = ["anthropic", "openai", "openai-compatible", "google", "ollama"] as const;
export type AiVendor = (typeof AI_VENDORS)[number];

export const VENDOR_LABELS: Record<AiVendor, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-compatible": "OpenAI-compatible (LM Studio, vLLM, …)",
  google: "Google (Gemini)",
  ollama: "Ollama (local)",
};

export function isAiVendor(value: unknown): value is AiVendor {
  return typeof value === "string" && (AI_VENDORS as readonly string[]).includes(value);
}

/** Short vendor names for labels like `Anthropic.claude-opus-5`. */
export const VENDOR_SHORT_NAMES: Record<AiVendor, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-compatible": "OpenAI-compatible",
  google: "Google",
  ollama: "Ollama",
};

/** What an AI provider without a name of its own is called: its vendor and model, `Anthropic.claude-opus-5`. */
export function defaultApiLabel(vendor: AiVendor, model: string): string {
  return `${VENDOR_SHORT_NAMES[vendor]}.${model}`;
}

/** Vendors that work without an API key (a server on your own machine). */
export const KEYLESS_VENDORS: readonly AiVendor[] = ["ollama", "openai-compatible"];

/** The address a vendor's server is expected at when none is given. */
export const DEFAULT_ADDRESSES: Partial<Record<AiVendor, string>> = {
  ollama: "http://localhost:11434",
  "openai-compatible": "http://localhost:1234/v1",
};
