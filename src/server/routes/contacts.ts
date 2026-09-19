import type { Database } from "bun:sqlite";
import { json, requireAuth, withErrorHandling } from "../http";
import { suggestContacts } from "../models/contacts";
import { getOwnedAccountByEmailParam } from "./accounts";

/** Recipient autocomplete for one account (optionally plus the user's other accounts) — see suggestContacts for how candidates are ranked. */
export function contactsRoutes(db: Database) {
  return {
    "/api/accounts/:email/contacts": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const url = new URL(req.url);

        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? 8);

        // `scope=all` adds matches from the user's other accounts after this account's own.
        const includeOtherAccounts = url.searchParams.get("scope") === "all";

        return json(suggestContacts(db, account.id, q, { limit: Number.isFinite(limit) ? limit : 8, includeOtherAccounts }));
      }),
    },
  };
}
