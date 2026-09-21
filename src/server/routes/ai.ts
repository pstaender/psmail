import type { Database } from "bun:sqlite";
import { isAiCategory, isAiVendor, type AiCategory } from "../../ai/categories";
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
  recordAiUsage,
  updateAiApi,
  updateAiSkill,
  type AiApiConfig,
  type AiApiInput,
  type AiSkillInput,
  type AiSkillRecord,
} from "../models/ai";
import { assertAccountEnabled, listAccounts } from "../models/accounts";
import { getEmail, getEmailRow, setEmailAiFields } from "../models/emails";
import { getUserSettings } from "../models/userSettings";
import { complete, emailTextForAi, listModels, parseTaxonomy, runSkill } from "../services/ai";
import { icsFromAnswer } from "../services/ics";
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

  /** Runs a skill on `text`, keeps the tokens it used on the provider's record, and returns the answer. */
  async function runCounted(skill: AiSkillRecord, api: AiApiConfig, text: string, language: string): Promise<string> {
    const result = await runSkill(skill, api, text, language);
    recordAiUsage(db, api.id, result.usage);
    return result.text;
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
    assertAccountEnabled(account); // the AI results are stored on the message, which a disabled account doesn't allow
    const emailId = parseIntParam(req.params.emailId, "emailId");
    const row = getEmailRow(db, emailId);
    if (row.account_id !== account.id) throw new NotFoundError(`Email ${emailId} not found`);
    return getEmail(db, emailId);
  }

  async function categorizeMessage(userId: number, encryptionKey: Buffer, emailId: number) {
    const skill = requireSkill(userId, "categorize");
    const email = getEmail(db, emailId);
    const answer = await runCounted(skill, getAiApiConfig(db, userId, skill.aiApiId, encryptionKey), emailTextForAi(email), DEFAULT_LANGUAGE);
    const labels = parseTaxonomy(answer);
    if (labels.length === 0) throw new ApiError(502, "The AI didn't return any categories.");
    return setEmailAiFields(db, emailId, { taxonomyList: labels });
  }

  /** Finds dates and events in a message and stores each as a .ics text. Finding none is a result too (an empty list is stored). */
  async function findEvents(userId: number, encryptionKey: Buffer, emailId: number) {
    const skill = requireSkill(userId, "events");
    const email = getEmail(db, emailId);
    const answer = await runCounted(skill, getAiApiConfig(db, userId, skill.aiApiId, encryptionKey), emailTextForAi(email), DEFAULT_LANGUAGE);
    return setEmailAiFields(db, emailId, { calendarEvents: icsFromAnswer(answer, emailId) });
  }

  /** Summarizes a message and stores the summary; the taxonomy and the events too, when those skills exist (their failure keeps the summary). */
  async function summarizeMessage(userId: number, encryptionKey: Buffer, email: ReturnType<typeof getEmail>, skillId?: unknown) {
    const skill = requireSkill(userId, "summarize", skillId);
    const api = getAiApiConfig(db, userId, skill.aiApiId, encryptionKey);
    const summary = await runCounted(skill, api, emailTextForAi(email), DEFAULT_LANGUAGE);
    let updated = setEmailAiFields(db, email.id, { aiSummary: summary });

    let taxonomyError: string | undefined;
    if (findSkillForCategory(db, userId, "categorize")) {
      try {
        updated = await categorizeMessage(userId, encryptionKey, email.id);
      } catch (error) {
        taxonomyError = error instanceof Error ? error.message : String(error);
      }
    }

    let eventsError: string | undefined;
    if (findSkillForCategory(db, userId, "events")) {
      try {
        updated = await findEvents(userId, encryptionKey, email.id);
      } catch (error) {
        eventsError = error instanceof Error ? error.message : String(error);
      }
    }
    return { email: updated, taxonomyError, eventsError };
  }

  /**
   * Summarizes the stored mail of the chosen accounts one message at a time (newest first, so an interrupted run has done the most
   * useful part), reporting through `send`: `start`, `account`, `working` (before each AI call — they can take long), `message` (after
   * it; with `verbose` incl. the summary), `progress`, `account-done`, `done`. Without `force` only messages without a summary; `folder`
   * limits it to one folder. A message that fails is reported and skipped; five failures in a row (a wrong key, a server that is
   * down) stop that account instead of grinding through the rest.
   */
  async function summarizeBatch(
    userId: number,
    encryptionKey: Buffer,
    accounts: ReturnType<typeof listAccounts>,
    options: { folder?: string; force: boolean; verbose: boolean },
    send: (event: Record<string, unknown>) => void
  ) {
    const started = Date.now();
    const results: Record<string, unknown>[] = [];
    send({ type: "start", accounts: accounts.map(a => a.email), folder: options.folder ?? null, force: options.force });

    for (const account of accounts) {
      if (account.disabled) {
        const skipped = { account: account.email, examined: 0, summarized: 0, failed: 0, skipped: "the account is disabled" };
        results.push(skipped);
        send({ type: "account-done", ...skipped });
        continue;
      }
      const stored = db.query<{ folder: string }, [number]>("SELECT DISTINCT folder FROM emails WHERE account_id = ?").all(account.id).map(r => r.folder);
      const folders = options.folder ? stored.filter(f => f.toLowerCase() === options.folder!.toLowerCase()) : stored;
      const ids =
        folders.length === 0
          ? []
          : db
              .query<{ id: number }, (string | number)[]>(
                `SELECT id FROM emails WHERE account_id = ? AND folder IN (${folders.map(() => "?").join(",")})${
                  options.force ? "" : " AND (ai_summary IS NULL OR ai_summary = '')"
                } ORDER BY date DESC, id DESC`
              )
              .all(account.id, ...folders)
              .map(r => r.id);
      send({ type: "account", account: account.email, total: ids.length, folders: folders.sort() });

      let summarized = 0;
      let failed = 0;
      let inARow = 0;
      let stopped: string | undefined;
      let done = 0;
      for (const id of ids) {
        const email = getEmail(db, id);
        const subject = email.subject;
        const from = email.from[0]?.address ?? "unknown";
        done++;
        if (!email.plainText?.trim() && !email.htmlText?.trim()) {
          send({ type: "message", account: account.email, id, folder: email.folder, subject, from, ok: false, skipped: "no text" });
          continue;
        }
        send({ type: "working", account: account.email, id, folder: email.folder, subject, from, done, total: ids.length });
        const began = Date.now();
        try {
          const result = await summarizeMessage(userId, encryptionKey, email);
          summarized++;
          inARow = 0;
          send({
            type: "message",
            account: account.email,
            id,
            folder: email.folder,
            subject,
            from,
            ok: true,
            seconds: (Date.now() - began) / 1000,
            categories: result.email.taxonomyList ?? [],
            dates: result.email.calendarEvents?.length ?? 0,
            warnings: [result.taxonomyError, result.eventsError].filter(Boolean),
            ...(options.verbose ? { summary: result.email.aiSummary } : {}),
          });
        } catch (error) {
          failed++;
          inARow++;
          send({ type: "message", account: account.email, id, folder: email.folder, subject, from, ok: false, error: error instanceof Error ? error.message : String(error) });
          if (inARow >= 5) {
            stopped = `stopped after ${inARow} failures in a row`;
            break;
          }
        }
        send({ type: "progress", account: account.email, done, total: ids.length, summarized, failed });
      }
      const result = { account: account.email, examined: done, summarized, failed, ...(stopped ? { skipped: stopped } : {}) };
      results.push(result);
      send({ type: "account-done", ...result });
    }
    send({ type: "done", results, seconds: (Date.now() - started) / 1000 });
    return results;
  }

  return {
    /**
     * Summarizes stored mail like the Summarize button, for many messages (the CLI uses this). Body: `accounts?` (addresses; default
     * every account of the user), `folder?` (default all folders), `force?` (also messages that have a summary), `verbose?`, `stream?`
     * (newline-separated JSON events while it works — one AI call can take minutes).
     */
    "/api/ai/summarize": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const body = await optionalBody(req) as { accounts?: unknown; folder?: unknown; force?: unknown; verbose?: unknown; stream?: unknown };
        if (body.accounts !== undefined && (!Array.isArray(body.accounts) || body.accounts.some(a => typeof a !== "string"))) throw new ApiError(400, "accounts must be a list of account addresses");
        if (body.folder !== undefined && (typeof body.folder !== "string" || !body.folder.trim())) throw new ApiError(400, "folder must be a folder name");
        requireSkill(session.userId, "summarize"); // before anything starts: without one there is nothing to do

        const all = listAccounts(db, session.userId);
        const wanted = body.accounts as string[] | undefined;
        for (const address of wanted ?? []) if (!all.some(account => account.email === address)) throw new NotFoundError(`Account "${address}" not found`);
        const chosen = all.filter(account => !wanted || wanted.includes(account.email));
        const options = { folder: body.folder as string | undefined, force: body.force === true, verbose: body.verbose === true };

        if (body.stream !== true) return json({ results: await summarizeBatch(session.userId, encryptionKey, chosen, options, () => {}) });

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              await summarizeBatch(session.userId, encryptionKey, chosen, options, event => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)));
            } catch (error) {
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`));
            } finally {
              controller.close();
            }
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
      }),
    },
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
        const result = await complete(api, "You are a connection test. Answer with the single word: OK", "Ping");
        recordAiUsage(db, api.id, result.usage);
        return json({ ok: true, answer: result.text.slice(0, 80) });
      }),
    },
    /**
     * The models a local server offers (OpenAI-compatible: GET <address>/models; Ollama: /api/tags), for the model field. Body:
     * `{ vendor, baseUrl?, apiKey?, apiId? }` — with `apiId` an already saved provider's key is used when none is typed.
     */
    "/api/ai/models": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const body = await readJsonBody<{ vendor?: unknown; baseUrl?: unknown; apiKey?: unknown; apiId?: unknown }>(req);
        if (!isAiVendor(body.vendor)) throw new ApiError(400, "Unknown vendor");
        let apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : null;
        if (!apiKey && typeof body.apiId === "number") apiKey = getAiApiConfig(db, session.userId, body.apiId, encryptionKey).apiKey ?? null;
        const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : null;
        return json({ models: await listModels(body.vendor, baseUrl, apiKey) });
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
        if (!isAiCategory(body.category) || body.category === "categorize" || body.category === "events") throw new ApiError(400, "category must be summarize, translate, grammar or improve");
        if (typeof body.text !== "string" || !body.text.trim()) throw new ApiError(400, "text is required");
        if (body.text.length > MAX_TEXT) throw new ApiError(400, "The text is too long for the AI");

        const skill = requireSkill(session.userId, body.category, body.skillId);
        const api = getAiApiConfig(db, session.userId, skill.aiApiId, encryptionKey);
        return json({ text: await runCounted(skill, api, body.text, languageFor(session.userId, body.language)) });
      }),
    },
    /** Summarizes a message and stores the summary; if a categorize skill exists it also stores the taxonomy, and if a "find dates and events" skill exists the events as .ics texts (a failure in either doesn't lose the summary). */
    "/api/accounts/:email/emails/:emailId/ai/summarize": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const email = ownedEmail(req, session.userId);
        const body = await optionalBody(req);

        return json(await summarizeMessage(session.userId, encryptionKey, email, body.skillId));
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
        const translated = await runCounted(skill, api, emailTextForAi(email), language);
        return json({ email: setEmailAiFields(db, email.id, { translatedText: translated, translatedLanguage: language }) });
      }),
    },
  };
}
