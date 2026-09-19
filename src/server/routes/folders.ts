import type { Database } from "bun:sqlite";
import { decryptAccountCredentials, learnSpecialFolders } from "../models/accounts";
import { getFolderCounts, type FolderCount } from "../models/emails";
import { json, requireAuth, withErrorHandling } from "../http";
import { listFolders, withImapClient, type ImapFolder } from "../services/imap";
import { getOwnedAccountByEmailParam } from "./accounts";

export interface FolderWithCounts extends ImapFolder {
  total: number;
  unread: number;
}

/**
 * Merges the account's live IMAP folder list with local message counts — a pure function (no
 * I/O) so it's unit-testable without a real IMAP connection.
 *
 * A folder that only exists locally (most commonly "Drafts", when the account has no
 * server-side Drafts folder at all — see resolveSpecialFolder in lib/folders.ts) still gets a
 * synthetic entry here so it stays reachable: GET .../emails?folder=X only ever reads the
 * local database, so viewing it never required a live IMAP counterpart in the first place.
 * specialUse on a synthetic entry is guessed from the name purely for a sensible icon — it's a
 * last resort, only reached when nothing from the server described it at all.
 */
export function mergeFolderCounts(liveFolders: ImapFolder[], localCounts: FolderCount[]): FolderWithCounts[] {
  const counts = new Map(localCounts.map(c => [c.folder, c]));

  const merged = liveFolders.map(folder => ({
    ...folder,
    total: counts.get(folder.path)?.total ?? 0,
    unread: counts.get(folder.path)?.unread ?? 0,
  }));

  const livePaths = new Set(liveFolders.map(f => f.path));
  const guessedSpecialUse: Record<string, string> = { Drafts: "\\Drafts", Sent: "\\Sent", Trash: "\\Trash" };
  for (const [folderName, count] of counts) {
    if (livePaths.has(folderName)) continue;
    merged.push({
      path: folderName,
      name: folderName,
      delimiter: "/",
      specialUse: guessedSpecialUse[folderName] ?? null,
      flags: [],
      total: count.total,
      unread: count.unread,
    });
  }

  return merged;
}

/**
 * Folder structure is read live from IMAP (so newly-created remote folders
 * show up even before a sync), merged with local message counts from
 * whatever has already been downloaded.
 */
export function foldersRoutes(db: Database) {
  return {
    "/api/accounts/:email/folders": {
      GET: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const { imapPassword } = decryptAccountCredentials(account, encryptionKey);

        const folders = await withImapClient(
          {
            host: account.imap_host,
            port: account.imap_port,
            secure: !!account.imap_secure,
            username: account.imap_username,
            password: imapPassword,
          },
          client => listFolders(client)
        );

        learnSpecialFolders(db, account.id, folders);

        return json(mergeFolderCounts(folders, getFolderCounts(db, account.id)));
      }),
    },
  };
}
