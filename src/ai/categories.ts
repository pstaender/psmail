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

/** Vendors the app can talk to. `ollama` (a local server) needs no key; the others do. */
export const AI_VENDORS = ["anthropic", "openai", "google", "ollama"] as const;
export type AiVendor = (typeof AI_VENDORS)[number];

export const VENDOR_LABELS: Record<AiVendor, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
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
  google: "Google",
  ollama: "Ollama",
};

/** What an AI provider without a name of its own is called: its vendor and model, `Anthropic.claude-opus-5`. */
export function defaultApiLabel(vendor: AiVendor, model: string): string {
  return `${VENDOR_SHORT_NAMES[vendor]}.${model}`;
}
