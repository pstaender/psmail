import type { Database } from "bun:sqlite";
import { decryptAccountCredentials } from "../models/accounts";
import { createDownloadJob, getDownloadJob, listDownloadJobs } from "../models/downloads";
import { getUserRowById } from "../models/users";
import { json, parseIntParam, readJsonBody, requireAuth, withErrorHandling } from "../http";
import { NotFoundError } from "../types";
import { runSync } from "../services/sync";
import { getOwnedAccountByEmailParam } from "./accounts";

interface CreateDownloadBody {
  folder?: string;
}

export function downloadsRoutes(db: Database) {
  return {
    "/api/accounts/:email/downloads": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        return json(listDownloadJobs(db, account.id));
      }),
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const username = getUserRowById(db, session.userId)!.username;

        const body = req.headers.get("content-length") === "0" ? {} : await readJsonBody<CreateDownloadBody>(req);
        const folder = body.folder ?? "INBOX";

        const job = createDownloadJob(db, account.id, folder);
        if (process.env.NODE_ENV !== "test") console.log(`[sync] queued job #${job.id} for ${account.email}/${folder}`);
        const { imapPassword } = decryptAccountCredentials(account, encryptionKey);

        // Run in the background; the client polls GET .../downloads/:id for progress.
        runSync({
          db,
          account,
          username,
          folder,
          downloadJobId: job.id,
          imapCredentials: {
            host: account.imap_host,
            port: account.imap_port,
            secure: !!account.imap_secure,
            username: account.imap_username,
            password: imapPassword,
          },
        }).catch(error => {
          console.error(`Sync job ${job.id} failed:`, error);
        });

        return json(job, { status: 202 });
      }),
    },
    "/api/accounts/:email/downloads/:id": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        const id = parseIntParam(req.params.id, "id");

        const job = getDownloadJob(db, id);
        if (job.accountId !== account.id) throw new NotFoundError(`Download job ${id} not found`);

        return json(job);
      }),
    },
  };
}
