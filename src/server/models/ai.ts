import { Database } from "bun:sqlite";
import { AI_VENDORS, VENDOR_LABELS, isAiCategory, isAiVendor, type AiCategory, type AiVendor } from "../../ai/categories";
import { decryptSecret, encryptSecret } from "../crypto/secrets";
import { ApiError, NotFoundError } from "../types";

export interface AiApiRecord {
  id: number;
  /** What the user calls it ("Work Claude"); defaults to "<Vendor> <model>". */
  name: string;
  vendor: AiVendor;
  model: string;
  /** Overrides the vendor's default address — needed for Ollama (the local server) and OpenAI-compatible services. */
  baseUrl: string | null;
  /** Whether a key is stored. The key itself is never returned. */
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AiApiRow {
  id: number;
  user_id: number;
  name: string;
  vendor: string;
  model: string;
  base_url: string | null;
  api_key_encrypted: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiApiInput {
  name?: string;
  vendor?: string;
  model?: string;
  baseUrl?: string | null;
  /** On update: omitted = keep the stored key; null = remove it (only sensible for Ollama). */
  apiKey?: string | null;
}

function toApi(row: AiApiRow): AiApiRecord {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor as AiVendor,
    model: row.model,
    baseUrl: row.base_url,
    hasKey: row.api_key_encrypted !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError(400, "The address must be a full URL such as http://localhost:11434");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ApiError(400, "The address must start with http:// or https://");
  return trimmed.replace(/\/+$/, "");
}

function requireVendor(value: unknown): AiVendor {
  if (!isAiVendor(value)) throw new ApiError(400, `vendor must be one of: ${AI_VENDORS.join(", ")}`);
  return value;
}

export function listAiApis(db: Database, userId: number): AiApiRecord[] {
  return db.query<AiApiRow, [number]>("SELECT * FROM ai_apis WHERE user_id = ? ORDER BY id").all(userId).map(toApi);
}

function getApiRow(db: Database, userId: number, id: number): AiApiRow {
  const row = db.query<AiApiRow, [number, number]>("SELECT * FROM ai_apis WHERE id = ? AND user_id = ?").get(id, userId);
  if (!row) throw new NotFoundError(`AI API ${id} not found`);
  return row;
}

export function createAiApi(db: Database, userId: number, input: AiApiInput, encryptionKey: Buffer): AiApiRecord {
  const vendor = requireVendor(input.vendor);
  const model = input.model?.trim();
  if (!model) throw new ApiError(400, "model is required");
  const apiKey = input.apiKey?.trim() || null;
  if (vendor !== "ollama" && !apiKey) throw new ApiError(400, `${VENDOR_LABELS[vendor]} needs an API key`);
  const name = input.name?.trim() || `${VENDOR_LABELS[vendor]} ${model}`;

  const row = db
    .query<AiApiRow, [number, string, string, string, string | null, string | null]>(
      `INSERT INTO ai_apis (user_id, name, vendor, model, base_url, api_key_encrypted) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(userId, name, vendor, model, cleanBaseUrl(input.baseUrl), apiKey ? encryptSecret(apiKey, encryptionKey) : null);
  return toApi(row!);
}

export function updateAiApi(db: Database, userId: number, id: number, input: AiApiInput, encryptionKey: Buffer): AiApiRecord {
  const existing = getApiRow(db, userId, id);
  const vendor = input.vendor !== undefined ? requireVendor(input.vendor) : (existing.vendor as AiVendor);
  const model = input.model !== undefined ? input.model.trim() : existing.model;
  if (!model) throw new ApiError(400, "model is required");

  let keyEncrypted = existing.api_key_encrypted;
  if (input.apiKey === null) keyEncrypted = null;
  else if (typeof input.apiKey === "string" && input.apiKey.trim()) keyEncrypted = encryptSecret(input.apiKey.trim(), encryptionKey);
  if (vendor !== "ollama" && keyEncrypted === null) throw new ApiError(400, `${VENDOR_LABELS[vendor]} needs an API key`);

  const row = db
    .query<AiApiRow, [string, string, string, string | null, string | null, number]>(
      `UPDATE ai_apis SET name = ?, vendor = ?, model = ?, base_url = ?, api_key_encrypted = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *`
    )
    .get(
      input.name !== undefined ? input.name.trim() || existing.name : existing.name,
      vendor,
      model,
      input.baseUrl !== undefined ? cleanBaseUrl(input.baseUrl) : existing.base_url,
      keyEncrypted,
      id
    );
  return toApi(row!);
}

/** Deletes an API together with the skills that use it (they'd have nothing to run on). */
export function deleteAiApi(db: Database, userId: number, id: number): void {
  getApiRow(db, userId, id);
  db.query("DELETE FROM ai_apis WHERE id = ?").run(id);
}

export interface AiApiConfig {
  vendor: AiVendor;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}

/** An API with its key decrypted — for making a call, never for sending to the client. */
export function getAiApiConfig(db: Database, userId: number, id: number, encryptionKey: Buffer): AiApiConfig {
  const row = getApiRow(db, userId, id);
  return {
    vendor: row.vendor as AiVendor,
    model: row.model,
    baseUrl: row.base_url,
    apiKey: row.api_key_encrypted ? decryptSecret(row.api_key_encrypted, encryptionKey) : null,
  };
}

export interface AiSkillRecord {
  id: number;
  aiApiId: number;
  category: AiCategory;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

interface AiSkillRow {
  id: number;
  user_id: number;
  ai_api_id: number;
  category: string;
  name: string;
  prompt: string;
  created_at: string;
  updated_at: string;
}

export interface AiSkillInput {
  aiApiId?: number;
  category?: string;
  name?: string;
  prompt?: string;
}

const MAX_PROMPT_LENGTH = 8000;

function toSkill(row: AiSkillRow): AiSkillRecord {
  return {
    id: row.id,
    aiApiId: row.ai_api_id,
    category: row.category as AiCategory,
    name: row.name,
    prompt: row.prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanPrompt(value: string | undefined): string {
  const prompt = value?.trim();
  if (!prompt) throw new ApiError(400, "prompt is required");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new ApiError(400, `prompt is too long (max ${MAX_PROMPT_LENGTH} characters)`);
  return prompt;
}

export function listAiSkills(db: Database, userId: number): AiSkillRecord[] {
  return db.query<AiSkillRow, [number]>("SELECT * FROM ai_skills WHERE user_id = ? ORDER BY id").all(userId).map(toSkill);
}

function getSkillRow(db: Database, userId: number, id: number): AiSkillRow {
  const row = db.query<AiSkillRow, [number, number]>("SELECT * FROM ai_skills WHERE id = ? AND user_id = ?").get(id, userId);
  if (!row) throw new NotFoundError(`AI skill ${id} not found`);
  return row;
}

export function createAiSkill(db: Database, userId: number, input: AiSkillInput): AiSkillRecord {
  if (!isAiCategory(input.category)) throw new ApiError(400, "Unknown skill category");
  if (typeof input.aiApiId !== "number") throw new ApiError(400, "aiApiId is required");
  getApiRow(db, userId, input.aiApiId); // must be one of this user's
  const name = input.name?.trim() || input.category;

  const row = db
    .query<AiSkillRow, [number, number, string, string, string]>(
      `INSERT INTO ai_skills (user_id, ai_api_id, category, name, prompt) VALUES (?, ?, ?, ?, ?) RETURNING *`
    )
    .get(userId, input.aiApiId, input.category, name, cleanPrompt(input.prompt));
  return toSkill(row!);
}

export function updateAiSkill(db: Database, userId: number, id: number, input: AiSkillInput): AiSkillRecord {
  const existing = getSkillRow(db, userId, id);
  if (input.category !== undefined && !isAiCategory(input.category)) throw new ApiError(400, "Unknown skill category");
  if (input.aiApiId !== undefined) getApiRow(db, userId, input.aiApiId);

  const row = db
    .query<AiSkillRow, [number, string, string, string, number]>(
      `UPDATE ai_skills SET ai_api_id = ?, category = ?, name = ?, prompt = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`
    )
    .get(
      input.aiApiId ?? existing.ai_api_id,
      input.category ?? existing.category,
      input.name !== undefined ? input.name.trim() || existing.name : existing.name,
      input.prompt !== undefined ? cleanPrompt(input.prompt) : existing.prompt,
      id
    );
  return toSkill(row!);
}

export function deleteAiSkill(db: Database, userId: number, id: number): void {
  getSkillRow(db, userId, id);
  db.query("DELETE FROM ai_skills WHERE id = ?").run(id);
}

/** The skill used when a button of this category is pressed: the user's first one (oldest). */
export function findSkillForCategory(db: Database, userId: number, category: AiCategory): AiSkillRecord | null {
  const row = db
    .query<AiSkillRow, [number, string]>("SELECT * FROM ai_skills WHERE user_id = ? AND category = ? ORDER BY id LIMIT 1")
    .get(userId, category);
  return row ? toSkill(row) : null;
}
