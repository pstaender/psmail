import type { Database } from "bun:sqlite";
import { decryptAccountCredentials } from "../models/accounts";
import { getFolderCounts } from "../models/emails";
import { json, requireAuth, withErrorHandling } from "../http";
import { listFolders, withImapClient } from "../services/imap";
import { getOwnedAccountByEmailParam } from "./accounts";

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

        const counts = new Map(getFolderCounts(db, account.id).map(c => [c.folder, c]));

        return json(
          folders.map(folder => ({
            ...folder,
            total: counts.get(folder.path)?.total ?? 0,
            unread: counts.get(folder.path)?.unread ?? 0,
          }))
        );
      }),
    },
  };
}
