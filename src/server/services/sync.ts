import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getEmailAttachmentsDir, sanitizeSegment } from "../config/paths";
import { classifyAndStore, createImboxContext, isImboxFolder, type ImboxContext } from "../models/imbox";
import { addAttachment, createEmail, deleteEmail, findEmailByUid, findSentPlaceholderByMessageId, listSyncedRefs, updateEmail } from "../models/emails";
import { completeDownloadJob, failDownloadJob, startDownloadJob, updateDownloadProgress, updateDownloadTotal } from "../models/downloads";
import { isAccountDisabled, learnSpecialFolders, type AccountRow } from "../models/accounts";
import { isUidDeleted, listDeletedUids, maxDeletedUid, removeDeletedUids } from "../models/tombstones";
import { getFolderUidValidity, getHighestSyncedUid, setFolderUidValidity, setHighestSyncedUid } from "../models/folderValidity";
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
  type RemoteFlagsResult,
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

/** The real IMAP flag lookup — connects and reads the current \Seen/\Flagged state of the given UIDs, plus the folder's UIDVALIDITY. */
async function defaultFetchRemoteFlags(creds: ImapCredentials, folder: string, uids: number[]): Promise<RemoteFlagsResult> {
  return withImapClient(creds, client => fetchRemoteFlagsFromServer(client, folder, uids));
}

type FetchMessagesFn = (creds: ImapCredentials, folder: string, sinceUid: number, hooks?: FetchHooks) => Promise<{ messages: FetchedMessage[] }>;
type FetchRemoteFlagsFn = (creds: ImapCredentials, folder: string, uids: number[]) => Promise<RemoteFlagsResult>;

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
 *
 * A UID only means anything within the folder's current UIDVALIDITY — if the server has renumbered the folder from
 * scratch since the last time this ran (rare: a rebuild, a repair, certain migrations), every UID stored here may
 * now name a different message or nothing at all. Trusting them anyway is exactly what could make a message that
 * is still genuinely on the server look "gone" and get deleted here, permanently, for good — so a *change* from a
 * previously-recorded UIDVALIDITY skips reconciling by UID entirely for this run (nothing here is treated as
 * missing, nothing here has its flags "corrected" from what could be a completely unrelated message) and asks the
 * caller for a full resync instead, so the folder's current messages get discovered fresh, under their real UIDs.
 * The very first time a folder is seen (no UIDVALIDITY recorded yet, e.g. an install from before this existed) is
 * NOT treated as a change — there is nothing to compare against, and treating it as one would force a needless full
 * re-download of every already-known message on the next sync of every account's every folder.
 */
async function reconcileExisting(
  db: Database,
  accountId: number,
  folder: string,
  imapCredentials: ImapCredentials,
  fetchRemoteFlags: FetchRemoteFlagsFn
): Promise<{ needsFullResync: boolean }> {
  const refs = listSyncedRefs(db, accountId, folder);
  // UIDs deleted locally only (read-only accounts) are checked too, so their tombstones can be
  // dropped once the server itself no longer has the message.
  const tombstones = listDeletedUids(db, accountId, folder);

  // The UIDVALIDITY is read (and recorded) every run, even with nothing yet to reconcile by UID — a folder's first
  // sync would otherwise leave no baseline at all, and a change right after that could go undetected the next time
  // there IS something to check (nothing to compare the new value against would look exactly like "no change").
  const { uidValidity, flags: remote } = await fetchRemoteFlags(imapCredentials, folder, [...refs.map(ref => ref.uid), ...tombstones]);
  const storedValidity = getFolderUidValidity(db, accountId, folder);
  setFolderUidValidity(db, accountId, folder, uidValidity);
  if (refs.length === 0 && tombstones.length === 0) return { needsFullResync: false };
  if (storedValidity !== null && storedValidity !== uidValidity) {
    syncLog(`${folder}: UIDVALIDITY changed (${storedValidity} -> ${uidValidity}) — not trusting stored UIDs this run, asking for a full resync`);
    return { needsFullResync: true };
  }

  removeDeletedUids(db, accountId, folder, tombstones.filter(uid => !remote.has(uid)));

  for (const ref of refs) {
    const state = remote.get(ref.uid);
    if (!state) {
      deleteEmail(db, ref.id);
      continue;
    }
    // "Forwarded" is only ever turned on (another client set $Forwarded); a server that doesn't keep the keyword doesn't undo it.
    const newlyForwarded = state.forwarded && !ref.isForwarded;
    if (state.seen !== ref.isRead || state.flagged !== ref.isFlagged || newlyForwarded) {
      updateEmail(db, ref.id, { isRead: state.seen, isFlagged: state.flagged, ...(newlyForwarded ? { isForwarded: true } : {}) });
    }
  }
  return { needsFullResync: false };
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
    const { needsFullResync } = await reconcileExisting(db, account.id, folderPath, imapCredentials, fetchRemoteFlags);

    // A UIDVALIDITY change makes every UID this app has stored for the folder unusable as a watermark too (they may
    // now belong to different messages, or nothing) — 0 asks for everything currently in the folder, fresh; already-
    // known messages (their real, current UID recognized) are simply skipped again by the loop below.
    //
    // The watermark itself is NOT "the highest UID any locally-stored message happens to have" — see the schema
    // comment on folder_uid_validity for why that's unsafe: sending or moving a message writes its real server UID
    // straight into the local row, without the folder ever actually having been walked that far. Trusting that as
    // "already covered" is exactly how a message another mail client appended in between became permanently
    // invisible — every later sync only ever asked for UIDs newer than a watermark that had silently jumped ahead
    // of messages it had never actually looked at.
    let sinceUid = 0;
    if (!needsFullResync) {
      const highestSynced = getHighestSyncedUid(db, account.id, folderPath) ?? 0;
      // The watermark also counts tombstoned UIDs: deleting the newest message locally must not make it look "new" again.
      sinceUid = Math.max(highestSynced, maxDeletedUid(db, account.id, folderPath));
    }

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

        // Not a message the server is showing us for the first time — this app sent it, and already stored it under this
        // same Message-ID without a UID (see findSentPlaceholderByMessageId's own comment). Attach the real UID instead of
        // storing a duplicate; the placeholder already has the full content, from composing it locally.
        const placeholder = parsed.messageId ? findSentPlaceholderByMessageId(db, account.id, folderPath, parsed.messageId) : null;
        if (placeholder) {
          updateEmail(db, placeholder.id, { uid: message.uid });
        } else {
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
      }

      downloaded += 1;
      if (downloaded % 25 === 0 || downloaded === messages.length) {
        syncLog(`${tag}: ${downloaded}/${messages.length} stored`);
      }
      updateDownloadProgress(db, downloadJobId, doneCurrent + downloaded);
      onProgress?.({ current: doneCurrent + downloaded, total: doneTotal + messages.length });
    }

    // The walk finished without throwing: every UID from sinceUid+1 up to the highest one the server returned has
    // now genuinely been examined (stored, or recognized as already known) — only now is it safe to move the
    // watermark that far. A message with a real UID written straight into a local row by some other path (see
    // above) never advances this on its own; the next sync still walks up to it for real, harmlessly finding it
    // already there (see findEmailByUid) alongside anything else in between that a plain send or move would have
    // silently skipped.
    const highestFetched = messages.reduce((max, message) => Math.max(max, message.uid), sinceUid);
    if (highestFetched > sinceUid || needsFullResync) setHighestSyncedUid(db, account.id, folderPath, highestFetched);

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
