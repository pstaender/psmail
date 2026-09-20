import type { Database } from "bun:sqlite";
import { assertAccountEnabled, decryptAccountCredentials, getFoldersCache, learnSpecialFolders, setFoldersCache, type AccountRow } from "../models/accounts";
import { getFolderCounts, type FolderCount } from "../models/emails";
import { json, requireAuth, withErrorHandling } from "../http";
import { applySpecialUseFallback, createFolder, describeImapError, FolderNameError, inboxFirst, listFolders, withImapClient, type ImapFolder } from "../services/imap";
import { ApiError, ConflictError } from "../types";
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
  const guessedSpecialUse: Record<string, string> = { drafts: "\\Drafts", sent: "\\Sent", trash: "\\Trash" };
  for (const [folderName, count] of counts) {
    if (livePaths.has(folderName)) continue;
    merged.push({
      path: folderName,
      name: folderName,
      delimiter: "/",
      specialUse: guessedSpecialUse[folderName.toLowerCase()] ?? null,
      flags: [],
      total: count.total,
      unread: count.unread,
    });
  }

  // Lists remembered before the name fallback existed lack it, so it is applied here too; and the Inbox is always first.
  return inboxFirst(applySpecialUseFallback(merged));
}

const LIVE_TIMEOUT_MS = 90_000;

/** Listings currently running, per account: concurrent requests share one IMAP connection instead of opening one each. */
const inflight = new Map<number, Promise<ImapFolder[]>>();

/** Reads the account's folder list from its IMAP server and remembers it (see the cache in GET below). */
function listLive(db: Database, account: AccountRow, encryptionKey: Buffer): Promise<ImapFolder[]> {
  const running = inflight.get(account.id);
  if (running) return running;

  const attempt = (async () => {
    const { imapPassword } = decryptAccountCredentials(account, encryptionKey);
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const folders = await Promise.race([
        withImapClient(
          {
            host: account.imap_host,
            port: account.imap_port,
            secure: !!account.imap_secure,
            username: account.imap_username,
            password: imapPassword,
          },
          client => listFolders(client)
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${LIVE_TIMEOUT_MS / 1000} s`)), LIVE_TIMEOUT_MS);
        }),
      ]);
      if (process.env.NODE_ENV !== "test") console.log(`[folders] ${account.email}: ${folders.length} folders from ${account.imap_host} in ${Date.now() - started} ms`);
      learnSpecialFolders(db, account.id, folders);
      setFoldersCache(db, account.id, folders);
      return folders;
    } catch (error) {
      if (process.env.NODE_ENV !== "test") console.error(`[folders] ${account.email}: listing failed after ${Date.now() - started} ms:`, error);
      throw new ApiError(502, `Couldn't read the folders of ${account.email} from ${account.imap_host}: ${describeImapError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => inflight.delete(account.id));

  inflight.set(account.id, attempt);
  return attempt;
}

/**
 * The account's folders with local message counts. The folder structure comes from IMAP, which can be slow (Gmail
 * sometimes needs many seconds), so the last live listing is kept: a plain request is answered from that at once
 * — with counts read fresh from the local database — and only `?live=1` (what the web client asks for in the
 * background after showing the cached tree) talks to the server. With no cache yet, even a plain request has to
 * go live. A failing live listing never hangs and never hides the downloaded mail: the folders that are stored locally are listed anyway, with the reason in an `x-folders-warning` header (a 502 with the reason only when nothing is stored either).
 */
export function foldersRoutes(db: Database) {
  return {
    "/api/accounts/:email/folders": {
      // Creates a folder on the IMAP server: { name, parent? } (parent is the path of an existing folder to nest it in).
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(account);
        if (account.read_only) throw new ConflictError(`Account "${account.email}" is read-only, so no folder can be created on its server.`);

        const body = (await req.json().catch(() => null)) as { name?: unknown; parent?: unknown } | null;
        if (!body || typeof body.name !== "string") throw new ApiError(400, "Missing folder name");
        const parent = typeof body.parent === "string" && body.parent !== "" ? body.parent : null;

        const { imapPassword } = decryptAccountCredentials(account, encryptionKey);
        let result;
        try {
          result = await withImapClient(
            { host: account.imap_host, port: account.imap_port, secure: !!account.imap_secure, username: account.imap_username, password: imapPassword },
            client => createFolder(client, body.name as string, parent)
          );
        } catch (error) {
          if (error instanceof FolderNameError) throw error.kind === "exists" ? new ConflictError(error.message) : new ApiError(error.kind === "missing-parent" ? 404 : 400, error.message);
          throw new ApiError(502, `Couldn't create the folder on ${account.imap_host}: ${describeImapError(error)}`);
        }

        learnSpecialFolders(db, account.id, result.folders);
        setFoldersCache(db, account.id, result.folders);
        return json({ path: result.path, folders: mergeFolderCounts(result.folders, getFolderCounts(db, account.id)) }, { status: 201 });
      }),

      GET: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const account = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        // A disabled account makes no connections: its folders are just the ones its stored mail is in.
        if (account.disabled) return json(mergeFolderCounts([], getFolderCounts(db, account.id)));

        const live = new URL(req.url).searchParams.get("live") === "1";
        const cached = getFoldersCache<ImapFolder>(db, account.id);
        const counts = getFolderCounts(db, account.id);

        try {
          const folders = !live && cached ? cached : await listLive(db, account, encryptionKey);
          return json(mergeFolderCounts(folders, counts), { headers: { "x-folders-source": !live && cached ? "cache" : "live" } });
        } catch (error) {
          // The server can't be reached (or throttles us): the mail already downloaded is still there to read, so list the
          // folders it is in — the remembered structure if there is one, else just the folders that hold stored mail —
          // and say why in a header. Only when there is nothing local to show at all is it an error.
          if (!(error instanceof ApiError) || (!cached && counts.length === 0)) throw error;
          return json(mergeFolderCounts(cached ?? [], counts), {
            headers: { "x-folders-source": "local", "x-folders-warning": encodeURIComponent(error.message) },
          });
        }
      }),
    },
  };
}
