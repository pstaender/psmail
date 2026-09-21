import type { Database } from "bun:sqlite";
import { json, requireAuth, withErrorHandling } from "../http";
import { readListFilter } from "../models/dateBounds";
import { listCategories } from "../models/emails";
import { searchEmails } from "../models/search";

/** Searches across every account the authenticated user owns — see models/search.ts for query syntax. */
export function searchRoutes(db: Database) {
  return {
    /** The categories the user's messages have (for the category filter), with their counts. */
    "/api/categories": {
      GET: withErrorHandling(async req => json(listCategories(db, requireAuth(req, db).session.userId))),
    },
    "/api/search": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const url = new URL(req.url);

        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const offset = Number(url.searchParams.get("offset") ?? 0);

        return json(searchEmails(db, session.userId, q, { limit, offset, fullText: url.searchParams.get("fulltext") === "1", ...readListFilter(url.searchParams) }));
      }),
    },
  };
}
