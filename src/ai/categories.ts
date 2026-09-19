import defaults from "./skillDefaults.json";

/** The kinds of AI skill, in display order. The suggested prompts live in skillDefaults.json. */
export const AI_CATEGORIES = ["summarize", "categorize", "translate", "grammar", "improve"] as const;
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
