import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getEmailAttachmentsDir, sanitizeSegment } from "../config/paths";
import { classifyAndStore, createImboxContext, isImboxFolder, type ImboxContext } from "../models/imbox";
import { addAttachment, createEmail, deleteEmail, findEmailByUid, listSyncedRefs, updateEmail } from "../models/emails";
import { completeDownloadJob, failDownloadJob, startDownloadJob, updateDownloadProgress, updateDownloadTotal } from "../models/downloads";
import { isAccountDisabled, learnSpecialFolders, type AccountRow } from "../models/accounts";
import { isUidDeleted, listDeletedUids, maxDeletedUid, removeDeletedUids } from "../models/tombstones";
import {
  fetchNewMessages,
  describeImapError,
  listFolders,
  type ImapFolder,
  type FetchHooks,
  fetchRemoteFlags as fetchRemoteFlagsFromServer,
  withImapClient,
  type FetchedMessage,
  type ImapCredentials,
  type RemoteFlagState,
} from "./imap";
import { parseMessage } from "./messageParser";

/** Sync narration for the server console; silent under `bun test` (NODE_ENV=test) to keep test output readable. */
function syncLog(message: string, ...rest: unknown[]) {
  if (process.env.NODE_ENV === "test") return;
  console.log(`[sync ${new Date().toISOString()}] ${message}`, ...rest);
}

const describeError = describeImapError;

export interface SyncProgress {
  current: number;
  total: number;
}

/** The real IMAP fetch — connects, opens `folder`, and pulls everything newer than `sinceUid`. */
async function defaultFetchMessages(
  creds: ImapCredentials,
  folder: string,
  sinceUid: number,
  hooks?: FetchHooks
): Promise<{ messages: FetchedMessage[] }> {
  syncLog(`connecting to ${creds.host}:${creds.port}...`);
  return withImapClient(creds, client => {
    syncLog("connected and authenticated");
    return fetchNewMessages(client, folder, sinceUid, message => syncLog(message), hooks);
  });
}

/** The real IMAP flag lookup — connects and reads the current \Seen/\Flagged state of the given UIDs. */
async function defaultFetchRemoteFlags(
  creds: ImapCredentials,
  folder: string,
  uids: number[]
): Promise<Map<number, RemoteFlagState>> {
  return withImapClient(creds, client => fetchRemoteFlagsFromServer(client, folder, uids));
}

type FetchMessagesFn = (creds: ImapCredentials, folder: string, sinceUid: number, hooks?: FetchHooks) => Promise<{ messages: FetchedMessage[] }>;
type FetchRemoteFlagsFn = (creds: ImapCredentials, folder: string, uids: number[]) => Promise<Map<number, RemoteFlagState>>;

export interface RunSyncOptions {
  db: Database;
  account: AccountRow;
  username: string;
  imapCredentials: ImapCredentials;
  downloadJobId: number;
  folder?: string;
  /** Sync every syncable folder the server lists instead of just `folder` (see runSync). */
  allFolders?: boolean;
  onProgress?: (progress: SyncProgress) => void;
  /**
   * Overridable for tests, so they can hand runSync canned messages as a plain function
   * argument instead of reaching for bun:test's mock.module — which replaces a module for
   * the rest of the test *run*, not just the file that called it (see the emailImapSync.test.ts
   * suite, which needs the real withImapClient elsewhere in the same run to hit an actually-
   * unreachable host on purpose). Defaults to the real IMAP fetch.
   */
  fetchMessages?: FetchMessagesFn;
  /** Same reasoning as `fetchMessages`, for the two-way reconciliation step (see reconcileExisting). */
  fetchRemoteFlags?: FetchRemoteFlagsFn;
  /** Same reasoning as `fetchMessages`, for listing the account's folders when `allFolders` is set. */
  listRemoteFolders?: (creds: ImapCredentials) => Promise<ImapFolder[]>;
}

/**
 * Pulls remote changes back down for messages already synced into this folder — the other
 * direction of the local -> IMAP push in routes/emails.ts. A flag change made by another IMAP
 * client is mirrored onto the local row; a UID no longer present on the server (deleted,
 * expunged, or moved elsewhere by another client) is removed locally too, so the folder view
 * doesn't keep showing something that's gone.
 */
async function reconcileExisting(
  db: Database,
  accountId: number,
  folder: string,
  imapCredentials: ImapCredentials,
  fetchRemoteFlags: FetchRemoteFlagsFn
): Promise<void> {
  const refs = listSyncedRefs(db, accountId, folder);
  // UIDs deleted locally only (read-only accounts) are checked too, so their tombstones can be
  // dropped once the server itself no longer has the message.
  const tombstones = listDeletedUids(db, accountId, folder);
  if (refs.length === 0 && tombstones.length === 0) return;

  const remote = await fetchRemoteFlags(imapCredentials, folder, [...refs.map(ref => ref.uid), ...tombstones]);
  removeDeletedUids(db, accountId, folder, tombstones.filter(uid => !remote.has(uid)));

  for (const ref of refs) {
    const state = remote.get(ref.uid);
    if (!state) {
      deleteEmail(db, ref.id);
      continue;
    }
    if (state.seen !== ref.isRead || state.flagged !== ref.isFlagged) {
      updateEmail(db, ref.id, { isRead: state.seen, isFlagged: state.flagged });
    }
  }
}

/** Folders that hold no real mail of their own: unselectable containers, and Gmail-style virtual views that would just duplicate everything. */
export function isSyncableFolder(folder: ImapFolder): boolean {
  if (folder.flags.some(flag => flag.toLowerCase() === "\\noselect" || flag.toLowerCase() === "\\nonexistent")) return false;
  return folder.specialUse !== "\\All" && folder.specialUse !== "\\Flagged";
}

async function defaultListRemoteFolders(creds: ImapCredentials): Promise<ImapFolder[]> {
  syncLog(`connecting to ${creds.host}:${creds.port} to list folders...`);
  return withImapClient(creds, client => listFolders(client));
}

/**
 * Runs an incremental sync: for each folder, fetches every message with a UID greater than the
 * highest one already stored, parses it, persists it (with attachments written to disk), and
 * reports progress via the downloads job row + optional callback (used by the CLI for a live
 * progress display). By default that's just `folder` (INBOX); with `allFolders`, every syncable
 * folder the server lists, Inbox first — a folder that fails is logged and skipped, the rest
 * still sync, and the job is marked failed at the end naming what went wrong.
 */
export async function runSync(options: RunSyncOptions): Promise<{ downloaded: number }> {
  const {
    db,
    account,
    username,
    imapCredentials,
    downloadJobId,
    folder = "INBOX",
    allFolders = false,
    onProgress,
    fetchMessages = defaultFetchMessages,
    fetchRemoteFlags = defaultFetchRemoteFlags,
    listRemoteFolders = defaultListRemoteFolders,
  } = options;

  const jobTag = `job #${downloadJobId} ${account.email}`;
  const startedAt = Date.now();
  let stage = "starting";

  let jobStarted = false;
  // Progress is reported across all folders: what finished folders contributed, plus the folder in flight.
  let doneTotal = 0;
  let doneCurrent = 0;
  const setTotal = (total: number) => {
    if (jobStarted) updateDownloadTotal(db, downloadJobId, total);
    else startDownloadJob(db, downloadJobId, total);
    jobStarted = true;
  };

  // New mail is classified for the imbox as it is stored. The context (who the user has written to, what each sender sent before) is
  // read once, on the first new message of the run, and kept up to date as messages are added.
  let imboxContext: ImboxContext | null = null;
  function classifyForImbox(emailId: number, folder: string) {
    try {
      if (!isImboxFolder(folder, account)) return;
      imboxContext ??= createImboxContext(db, account.user_id);
      classifyAndStore(db, imboxContext, emailId);
    } catch (error) {
      console.error(`[imbox] ${account.email}: classification skipped:`, error); // never lets a sync fail
    }
  }

  async function syncFolder(folderPath: string): Promise<number> {
    const tag = `${jobTag}/${folderPath}`;
    if (isAccountDisabled(db, account.id)) throw new Error("The account was disabled during the sync");
    stage = `${folderPath}: reconciling existing messages`;
    await reconcileExisting(db, account.id, folderPath, imapCredentials, fetchRemoteFlags);

    const maxUidRow = db
      .query<{ max_uid: number | null }, [number, string]>(
        "SELECT MAX(uid) as max_uid FROM emails WHERE account_id = ? AND folder = ?"
      )
      .get(account.id, folderPath);
    // The watermark also counts tombstoned UIDs: deleting the newest message locally must not make it look "new" again.
    const sinceUid = Math.max(maxUidRow?.max_uid ?? 0, maxDeletedUid(db, account.id, folderPath));

    stage = `${folderPath}: fetching messages newer than UID ${sinceUid}`;
    syncLog(`${tag}: ${stage}`);
    // While the (single, all-at-once) download runs, expose its progress on the job row: the
    // total is only an estimate (messages in the folder minus those already stored) until the
    // download ends, when it's replaced by the exact count.
    const { messages } = await fetchMessages(imapCredentials, folderPath, sinceUid, {
      onOpened: exists => {
        const alreadyStored = listSyncedRefs(db, account.id, folderPath).length;
        setTotal(doneTotal + Math.max(exists - alreadyStored, 0));
      },
      onDownloaded: count => updateDownloadProgress(db, downloadJobId, doneCurrent + count),
    });
    syncLog(`${tag}: server returned ${messages.length} new message(s)`);

    setTotal(doneTotal + messages.length);
    updateDownloadProgress(db, downloadJobId, doneCurrent);
    onProgress?.({ current: doneCurrent, total: doneTotal + messages.length });

    let downloaded = 0;
    for (const message of messages) {
      stage = `${folderPath}: processing UID ${message.uid}`;
      // Disabling the account stops a running sync: its stored mail must not change from then on.
      if (isAccountDisabled(db, account.id)) throw new Error("The account was disabled during the sync");
      if (!findEmailByUid(db, account.id, folderPath, message.uid) && !isUidDeleted(db, account.id, folderPath, message.uid)) {
        const parsed = await parseMessage(message.source);

        const email = createEmail(db, account.id, {
          folder: folderPath,
          uid: message.uid,
          isDraft: false,
          isRead: false,
          messageId: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          from: parsed.from,
          to: parsed.to,
          cc: parsed.cc,
          bcc: parsed.bcc,
          replyTo: parsed.replyTo,
          subject: parsed.subject,
          date: parsed.date,
          returnPath: parsed.returnPath,
          received: parsed.received,
          mimeVersion: parsed.mimeVersion,
          contentType: parsed.contentType,
          authenticationResults: parsed.authenticationResults,
          dkim: parsed.dkim,
          spf: parsed.spf,
          plainText: parsed.plainText,
          htmlText: parsed.htmlText,
          headersRaw: parsed.headersRaw,
          size: message.size,
        });

        if (parsed.attachments.length > 0) {
          const dir = getEmailAttachmentsDir(username, account.email, email.id);
          await Bun.$`mkdir -p ${dir}`.quiet();

          for (const attachment of parsed.attachments) {
            const safeName = sanitizeSegment(attachment.filename);
            const filePath = join(dir, safeName);
            await Bun.write(filePath, attachment.content);
            addAttachment(db, email.id, {
              filename: attachment.filename,
              contentType: attachment.contentType,
              contentId: attachment.contentId,
              isInline: attachment.isInline,
              size: attachment.size,
              filePath,
            });
          }
        }

        classifyForImbox(email.id, folderPath);
      }

      downloaded += 1;
      if (downloaded % 25 === 0 || downloaded === messages.length) {
        syncLog(`${tag}: ${downloaded}/${messages.length} stored`);
      }
      updateDownloadProgress(db, downloadJobId, doneCurrent + downloaded);
      onProgress?.({ current: doneCurrent + downloaded, total: doneTotal + messages.length });
    }

    doneTotal += messages.length;
    doneCurrent += messages.length;
    return downloaded;
  }

  try {
    syncLog(`${jobTag}: starting (IMAP ${imapCredentials.username}@${imapCredentials.host}:${imapCredentials.port}, ${imapCredentials.secure ? "TLS" : "no TLS"})`);

    let folderPaths = [folder];
    if (allFolders) {
      stage = "listing folders";
      const remote = await listRemoteFolders(imapCredentials);
      learnSpecialFolders(db, account.id, remote);
      const syncable = remote.filter(isSyncableFolder);
      // Inbox first, so new mail shows up before the long tail of archive folders is walked.
      folderPaths = [...syncable.filter(f => f.specialUse === "\\Inbox"), ...syncable.filter(f => f.specialUse !== "\\Inbox")].map(f => f.path);
      syncLog(`${jobTag}: syncing ${folderPaths.length} folder(s): ${folderPaths.join(", ")}`);
    }

    let downloaded = 0;
    const failures: string[] = [];
    for (const folderPath of folderPaths) {
      try {
        downloaded += await syncFolder(folderPath);
      } catch (error) {
        if (!allFolders) throw error;
        const description = describeError(error);
        syncLog(`${jobTag}/${folderPath}: FAILED while ${stage}: ${description}`);
        failures.push(`${folderPath}: ${description}`);
      }
    }

    if (!jobStarted) setTotal(0);
    if (failures.length > 0) {
      const summary = `${failures.length} of ${folderPaths.length} folder(s) failed — ${failures.join("; ")}`;
      failDownloadJob(db, downloadJobId, summary);
      syncLog(`${jobTag}: finished with errors after ${Date.now() - startedAt}ms, ${downloaded} message(s) stored: ${summary}`);
      return { downloaded };
    }

    completeDownloadJob(db, downloadJobId);
    syncLog(`${jobTag}: completed, ${downloaded} message(s) in ${Date.now() - startedAt}ms`);
    return { downloaded };
  } catch (error) {
    const description = describeError(error);
    syncLog(`${jobTag}: FAILED while ${stage} after ${Date.now() - startedAt}ms: ${description}`);
    failDownloadJob(db, downloadJobId, `${description} (while ${stage})`);
    throw error;
  }
}
