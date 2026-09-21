import type { Database } from "bun:sqlite";
import { json, readJsonBody, requireAuth, withErrorHandling } from "../http";
import { getUserSettings, updateUserSettings } from "../models/userSettings";
import { countUnifiedInboxUnread, isUnifiedKind, listNewInboxMail, listUnifiedEmails } from "../models/unified";
import { ApiError } from "../types";
import { readListFilter } from "../models/dateBounds";

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
    "/api/unified/inbox/unread": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const includeFolders = getUserSettings(db, session.userId).combinedInboxIncludesFolders === true;
        return json({ count: countUnifiedInboxUnread(db, session.userId, { includeFolders }) });
      }),
    },
    "/api/unified/imbox/unread": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const includeFolders = getUserSettings(db, session.userId).combinedInboxIncludesFolders === true;
        return json({ count: countUnifiedInboxUnread(db, session.userId, { includeFolders, imbox: true }) });
      }),
    },
    /** New unread mail in the combined Inbox since `afterId`; without it, just the current `latestId` to start from. */
    "/api/unified/inbox/new": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const after = new URL(req.url).searchParams.get("afterId");
        const afterId = after === null ? null : Number(after);
        if (afterId !== null && !Number.isInteger(afterId)) throw new ApiError(400, "afterId must be an integer");
        const includeFolders = getUserSettings(db, session.userId).combinedInboxIncludesFolders === true;
        return json(listNewInboxMail(db, session.userId, afterId, { includeFolders }));
      }),
    },
    /** Newest-first messages across all of the user's accounts: `inbox` (every Inbox), `imbox` (the important part of it) or `sent` (every Sent folder). */
    "/api/unified/:kind": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const kind = req.params.kind ?? "";
        if (!isUnifiedKind(kind)) throw new ApiError(404, `Unknown mailbox "${kind}" (expected inbox, imbox or sent)`);

        const url = new URL(req.url);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const includeFolders = getUserSettings(db, session.userId).combinedInboxIncludesFolders === true;
        return json(listUnifiedEmails(db, session.userId, kind, { limit, offset, includeFolders, ...readListFilter(url.searchParams) }));
      }),
    },
  };
}
