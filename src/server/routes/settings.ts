import type { Database } from "bun:sqlite";
import { json, readJsonBody, requireAuth, withErrorHandling } from "../http";
import { getUserSettings, updateUserSettings } from "../models/userSettings";
import { isUnifiedKind, listUnifiedEmails } from "../models/unified";
import { ApiError } from "../types";

export function settingsRoutes(db: Database) {
  return {
    "/api/settings": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        return json(getUserSettings(db, session.userId));
      }),
      PATCH: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const body = await readJsonBody<Record<string, unknown>>(req);
        return json(updateUserSettings(db, session.userId, body));
      }),
    },
    /** Newest-first messages across all of the user's accounts: `inbox` (every Inbox) or `sent` (every Sent folder). */
    "/api/unified/:kind": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const kind = req.params.kind ?? "";
        if (!isUnifiedKind(kind)) throw new ApiError(404, `Unknown mailbox "${kind}" (expected inbox or sent)`);

        const url = new URL(req.url);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return json(listUnifiedEmails(db, session.userId, kind, { limit, offset }));
      }),
    },
  };
}
