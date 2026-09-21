import type { Database } from "bun:sqlite";
import { assertAccountEnabled, listAccounts } from "../models/accounts";
import { json, parseIntParam, readJsonBody, requireAuth, withErrorHandling } from "../http";
import { classifyAccounts, classifySteps, explainEmail, setImbox, type ClassifyResult } from "../models/imbox";
import { getEmail, getEmailRow } from "../models/emails";
import { ApiError, NotFoundError } from "../types";
import { getOwnedAccountByEmailParam } from "./accounts";

type Chosen = { id: number; email: string; disabled: boolean }[];

function streamClassification(db: Database, userId: number, chosen: Chosen, force: boolean, verbose: boolean): Response {
  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      const results: (ClassifyResult & { account: string; skipped?: string })[] = [];
      try {
        send({ type: "start", accounts: chosen.map(a => a.email), force });
        for (const account of chosen) {
          if (account.disabled) {
            const skipped = { account: account.email, examined: 0, important: 0, notImportant: 0, skipped: "the account is disabled" };
            results.push(skipped);
            send({ type: "account-done", ...skipped });
            continue;
          }
          const steps = classifySteps(db, userId, {
            accountIds: [account.id],
            force,
            onAccount: info => send({ type: "account", ...info }),
            onProgress: info => send({ type: "progress", ...info }),
            onAccountDone: info => {
              results.push(info);
              send({ type: "account-done", ...info });
            },
            onMessage: verbose
              ? ({ account: name, row, verdict }) =>
                  send({
                    type: "message",
                    account: name,
                    id: row.id,
                    subject: row.subject,
                    from: row.from,
                    important: verdict.important,
                    score: verdict.score,
                    ruledOut: verdict.ruledOut,
                    reasons: [...verdict.reasons]
                      .filter(r => r.points !== 0)
                      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
                      .slice(0, 3)
                      .map(r => `${r.signal} (${r.points > 0 ? "+" : ""}${r.points})`),
                  })
              : undefined,
          });
          // Between chunks the event loop gets to run, so the events actually leave the server while the work goes on.
          for (;;) {
            const step = steps.next();
            if (step.done) break;
            await Bun.sleep(0);
          }
        }
        send({ type: "done", results, seconds: (Date.now() - started) / 1000 });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

/** The imbox: classifying existing mail (the CLI uses this), explaining a verdict, and overriding one by hand. */
export function imboxRoutes(db: Database) {
  return {
    /**
     * Classifies stored mail for the imbox. `accounts` (addresses) limits it to those accounts — default: every account of the user;
     * `force` re-classifies messages that already have a verdict. Disabled accounts are left alone (their stored mail is frozen).
     */
    "/api/imbox/classify": {
      POST: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const body = await readJsonBody<{ accounts?: unknown; force?: unknown; stream?: unknown; verbose?: unknown }>(req).catch(
          () => ({}) as { accounts?: unknown; force?: unknown; stream?: unknown; verbose?: unknown }
        );
        if (body.accounts !== undefined && (!Array.isArray(body.accounts) || body.accounts.some(a => typeof a !== "string"))) {
          throw new ApiError(400, "accounts must be a list of account addresses");
        }

        const all = listAccounts(db, session.userId);
        const wanted = body.accounts as string[] | undefined;
        for (const address of wanted ?? []) if (!all.some(account => account.email === address)) throw new NotFoundError(`Account "${address}" not found`);

        const chosen = all.filter(account => !wanted || wanted.includes(account.email));

        // `stream: true` answers with newline-separated JSON events while it works (start, account, progress, message, account-done,
        // done), so the CLI can show what is happening; `verbose` adds an event per message with its verdict and main reasons.
        if (body.stream === true) return streamClassification(db, session.userId, chosen, body.force === true, body.verbose === true);

        const results: (ClassifyResult & { account: string; skipped?: string })[] = [];
        for (const account of chosen) {
          if (account.disabled) {
            results.push({ account: account.email, examined: 0, important: 0, notImportant: 0, skipped: "the account is disabled" });
            continue;
          }
          results.push({ account: account.email, ...classifyAccounts(db, session.userId, { accountIds: [account.id], force: body.force === true }) });
        }
        return json({ results });
      }),
    },
    /** Why a message is (not) important: the verdict computed now — score and reasons — next to the stored one. */
    "/api/accounts/:email/emails/:emailId/imbox": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        if (getEmailRow(db, emailId).account_id !== account.id) throw new NotFoundError(`Email ${emailId} not found`);
        return json({ stored: getEmail(db, emailId).imbox, ...explainEmail(db, session.userId, emailId) });
      }),
      /** Overrides the verdict by hand: `{ imbox: true | false }`, or null to have it classified again next time. */
      PUT: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        const emailId = parseIntParam(req.params.emailId, "emailId");
        if (getEmailRow(db, emailId).account_id !== account.id) throw new NotFoundError(`Email ${emailId} not found`);
        const body = await readJsonBody<{ imbox?: unknown }>(req);
        if (body.imbox !== null && typeof body.imbox !== "boolean") throw new ApiError(400, "imbox must be true, false or null");
        setImbox(db, emailId, body.imbox);
        return json(getEmail(db, emailId));
      }),
    },
  };
}
