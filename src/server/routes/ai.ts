import type { Database } from "bun:sqlite";
import { isAiCategory, type AiCategory } from "../../ai/categories";
import { json, parseIntParam, readJsonBody, requireAuth, withErrorHandling } from "../http";
import {
  createAiApi,
  createAiSkill,
  deleteAiApi,
  deleteAiSkill,
  findSkillForCategory,
  getAiApiConfig,
  listAiApis,
  listAiSkills,
  updateAiApi,
  updateAiSkill,
  type AiApiInput,
  type AiSkillInput,
  type AiSkillRecord,
} from "../models/ai";
import { getEmail, getEmailRow, setEmailAiFields } from "../models/emails";
import { getUserSettings } from "../models/userSettings";
import { complete, emailTextForAi, parseTaxonomy, runSkill } from "../services/ai";
import { ApiError, NotFoundError } from "../types";
import { getOwnedAccountByEmailParam } from "./accounts";

const DEFAULT_LANGUAGE = "English";
const MAX_TEXT = 60_000;

/**
 * AI features: the user's AI APIs and skills (CRUD, stored per user; keys encrypted like account passwords) and the
 * calls that use them — `run` for composing (text in, text out, nothing stored) and the per-message endpoints
 * that keep their result on the message (summary, taxonomy, translation).
 */
export function aiRoutes(db: Database) {
  function languageFor(userId: number, requested: unknown): string {
    if (typeof requested === "string" && requested.trim()) return requested.trim().slice(0, 60);
    return getUserSettings(db, userId).aiTargetLanguage ?? DEFAULT_LANGUAGE;
  }

  function requireSkill(userId: number, category: AiCategory, skillId?: unknown): AiSkillRecord {
    const skill = findSkillForCategory(db, userId, category, typeof skillId === "number" ? skillId : undefined);
    if (!skill) throw new ApiError(409, `No "${category}" skill is set up yet — add one in Settings → AI.`);
    return skill;
  }

  /** The JSON body of a request that may have none (the buttons of a single-skill category post nothing). */
  async function optionalBody(req: Bun.BunRequest): Promise<{ skillId?: unknown; language?: unknown }> {
    if (req.headers.get("content-length") === "0") return {};
    return req.json().catch(() => ({}));
  }

  /** The message, checked to belong to one of the caller's accounts. */
  function ownedEmail(req: Bun.BunRequest, userId: number) {
    const account = getOwnedAccountByEmailParam(db, req.params.email, userId);
    const emailId = parseIntParam(req.params.emailId, "emailId");
    const row = getEmailRow(db, emailId);
    if (row.account_id !== account.id) throw new NotFoundError(`Email ${emailId} not found`);
    return getEmail(db, emailId);
  }

  async function categorizeMessage(userId: number, encryptionKey: Buffer, emailId: number) {
    const skill = requireSkill(userId, "categorize");
    const email = getEmail(db, emailId);
    const answer = await runSkill(skill, getAiApiConfig(db, userId, skill.aiApiId, encryptionKey), emailTextForAi(email), DEFAULT_LANGUAGE);
    const labels = parseTaxonomy(answer);
    if (labels.length === 0) throw new ApiError(502, "The AI didn't return any categories.");
    return setEmailAiFields(db, emailId, { taxonomyList: labels });
  }

  return {
    "/api/ai/apis": {
      GET: withErrorHandling(async req => json(listAiApis(db, requireAuth(req, db).session.userId))),
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        return json(createAiApi(db, session.userId, await readJsonBody<AiApiInput>(req), encryptionKey), { status: 201 });
      }),
    },
    "/api/ai/apis/:id": {
      PATCH: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        return json(updateAiApi(db, session.userId, parseIntParam(req.params.id, "id"), await readJsonBody<AiApiInput>(req), encryptionKey));
      }),
      DELETE: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        deleteAiApi(db, session.userId, parseIntParam(req.params.id, "id"));
        return new Response(null, { status: 204 });
      }),
    },
    /** Asks the API for a one-word answer, to check the vendor/model/key/address work. */
    "/api/ai/apis/:id/test": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const api = getAiApiConfig(db, session.userId, parseIntParam(req.params.id, "id"), encryptionKey);
        const answer = await complete(api, "You are a connection test. Answer with the single word: OK", "Ping");
        return json({ ok: true, answer: answer.slice(0, 80) });
      }),
    },
    "/api/ai/skills": {
      GET: withErrorHandling(async req => json(listAiSkills(db, requireAuth(req, db).session.userId))),
      POST: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        return json(createAiSkill(db, session.userId, await readJsonBody<AiSkillInput>(req)), { status: 201 });
      }),
    },
    "/api/ai/skills/:id": {
      PATCH: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        return json(updateAiSkill(db, session.userId, parseIntParam(req.params.id, "id"), await readJsonBody<AiSkillInput>(req)));
      }),
      DELETE: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        deleteAiSkill(db, session.userId, parseIntParam(req.params.id, "id"));
        return new Response(null, { status: 204 });
      }),
    },
    /** Composing: runs the user's skill of that category over some text (a draft) and returns the result; nothing is stored. */
    "/api/ai/run": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const body = await readJsonBody<{ category?: unknown; text?: unknown; language?: unknown; skillId?: unknown }>(req);
        if (!isAiCategory(body.category) || body.category === "categorize") throw new ApiError(400, "category must be summarize, translate, grammar or improve");
        if (typeof body.text !== "string" || !body.text.trim()) throw new ApiError(400, "text is required");
        if (body.text.length > MAX_TEXT) throw new ApiError(400, "The text is too long for the AI");

        const skill = requireSkill(session.userId, body.category, body.skillId);
        const api = getAiApiConfig(db, session.userId, skill.aiApiId, encryptionKey);
        return json({ text: await runSkill(skill, api, body.text, languageFor(session.userId, body.language)) });
      }),
    },
    /** Summarizes a message and stores the summary; if a categorize skill exists it also stores the taxonomy (a failure there doesn't lose the summary). */
    "/api/accounts/:email/emails/:emailId/ai/summarize": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const email = ownedEmail(req, session.userId);
        const body = await optionalBody(req);

        const skill = requireSkill(session.userId, "summarize", body.skillId);
        const api = getAiApiConfig(db, session.userId, skill.aiApiId, encryptionKey);
        const summary = await runSkill(skill, api, emailTextForAi(email), DEFAULT_LANGUAGE);
        let updated = setEmailAiFields(db, email.id, { aiSummary: summary });

        let taxonomyError: string | undefined;
        if (findSkillForCategory(db, session.userId, "categorize")) {
          try {
            updated = await categorizeMessage(session.userId, encryptionKey, email.id);
          } catch (error) {
            taxonomyError = error instanceof Error ? error.message : String(error);
          }
        }
        return json({ email: updated, taxonomyError });
      }),
    },
    "/api/accounts/:email/emails/:emailId/ai/categorize": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const email = ownedEmail(req, session.userId);
        return json({ email: await categorizeMessage(session.userId, encryptionKey, email.id) });
      }),
    },
    /** Translates a message into `language` (default: the user's setting) and stores the translation. */
    "/api/accounts/:email/emails/:emailId/ai/translate": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const email = ownedEmail(req, session.userId);
        const body = await optionalBody(req);

        const skill = requireSkill(session.userId, "translate", body.skillId);
        const language = languageFor(session.userId, body.language);
        const api = getAiApiConfig(db, session.userId, skill.aiApiId, encryptionKey);
        const translated = await runSkill(skill, api, emailTextForAi(email), language);
        return json({ email: setEmailAiFields(db, email.id, { translatedText: translated, translatedLanguage: language }) });
      }),
    },
  };
}
