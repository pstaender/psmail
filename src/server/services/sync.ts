import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getEmailAttachmentsDir, sanitizeSegment } from "../config/paths";
import { addAttachment, createEmail, deleteEmail, findEmailByUid, listSyncedRefs, updateEmail } from "../models/emails";
import { completeDownloadJob, failDownloadJob, startDownloadJob, updateDownloadProgress } from "../models/downloads";
import type { AccountRow } from "../models/accounts";
import {
  fetchNewMessages,
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

/** imapflow errors carry the server's actual complaint in fields beyond `message` (which is often just "Command failed"). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & { code?: string; responseStatus?: string; responseText?: string; serverResponseCode?: string; authenticationFailed?: boolean };
  const details = [
    extra.code && `code=${extra.code}`,
    extra.responseStatus && `status=${extra.responseStatus}`,
    extra.serverResponseCode && `serverCode=${extra.serverResponseCode}`,
    extra.responseText && `response="${extra.responseText}"`,
    extra.authenticationFailed && "authenticationFailed",
  ].filter(Boolean);
  return details.length > 0 ? `${error.message} (${details.join(", ")})` : error.message;
}

export interface SyncProgress {
  current: number;
  total: number;
}

/** The real IMAP fetch — connects, opens `folder`, and pulls everything newer than `sinceUid`. */
async function defaultFetchMessages(
  creds: ImapCredentials,
  folder: string,
  sinceUid: number
): Promise<{ messages: FetchedMessage[] }> {
  return withImapClient(creds, client => fetchNewMessages(client, folder, sinceUid));
}

/** The real IMAP flag lookup — connects and reads the current \Seen/\Flagged state of the given UIDs. */
async function defaultFetchRemoteFlags(
  creds: ImapCredentials,
  folder: string,
  uids: number[]
): Promise<Map<number, RemoteFlagState>> {
  return withImapClient(creds, client => fetchRemoteFlagsFromServer(client, folder, uids));
}

type FetchMessagesFn = (creds: ImapCredentials, folder: string, sinceUid: number) => Promise<{ messages: FetchedMessage[] }>;
type FetchRemoteFlagsFn = (creds: ImapCredentials, folder: string, uids: number[]) => Promise<Map<number, RemoteFlagState>>;

export interface RunSyncOptions {
  db: Database;
  account: AccountRow;
  username: string;
  imapCredentials: ImapCredentials;
  downloadJobId: number;
  folder?: string;
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
  if (refs.length === 0) return;

  const remote = await fetchRemoteFlags(imapCredentials, folder, refs.map(ref => ref.uid));

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

/**
 * Runs an incremental sync for a single folder: fetches every message with a
 * UID greater than the highest one already stored, parses it, persists it
 * (with attachments written to disk), and reports progress via the
 * downloads job row + optional callback (used by the CLI for a live
 * progress display).
 */
export async function runSync(options: RunSyncOptions): Promise<{ downloaded: number }> {
  const {
    db,
    account,
    username,
    imapCredentials,
    downloadJobId,
    folder = "INBOX",
    onProgress,
    fetchMessages = defaultFetchMessages,
    fetchRemoteFlags = defaultFetchRemoteFlags,
  } = options;

  const tag = `job #${downloadJobId} ${account.email}/${folder}`;
  const startedAt = Date.now();
  let stage = "reconciling existing messages";

  try {
    syncLog(`${tag}: starting (IMAP ${imapCredentials.username}@${imapCredentials.host}:${imapCredentials.port}, ${imapCredentials.secure ? "TLS" : "no TLS"})`);
    await reconcileExisting(db, account.id, folder, imapCredentials, fetchRemoteFlags);

    const maxUidRow = db
      .query<{ max_uid: number | null }, [number, string]>(
        "SELECT MAX(uid) as max_uid FROM emails WHERE account_id = ? AND folder = ?"
      )
      .get(account.id, folder);
    const sinceUid = maxUidRow?.max_uid ?? 0;

    stage = `fetching messages newer than UID ${sinceUid}`;
    syncLog(`${tag}: ${stage}`);
    const { messages } = await fetchMessages(imapCredentials, folder, sinceUid);
    syncLog(`${tag}: server returned ${messages.length} new message(s)`);

    startDownloadJob(db, downloadJobId, messages.length);
    onProgress?.({ current: 0, total: messages.length });

    let downloaded = 0;
    for (const message of messages) {
      stage = `processing UID ${message.uid}`;
      if (!findEmailByUid(db, account.id, folder, message.uid)) {
        const parsed = await parseMessage(message.source);

        const email = createEmail(db, account.id, {
          folder,
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
      }

      downloaded += 1;
      if (downloaded % 25 === 0 || downloaded === messages.length) {
        syncLog(`${tag}: ${downloaded}/${messages.length} stored`);
      }
      updateDownloadProgress(db, downloadJobId, downloaded);
      onProgress?.({ current: downloaded, total: messages.length });
    }

    completeDownloadJob(db, downloadJobId);
    syncLog(`${tag}: completed, ${downloaded} message(s) in ${Date.now() - startedAt}ms`);
    return { downloaded };
  } catch (error) {
    const description = describeError(error);
    syncLog(`${tag}: FAILED while ${stage} after ${Date.now() - startedAt}ms: ${description}`);
    failDownloadJob(db, downloadJobId, `${description} (while ${stage})`);
    throw error;
  }
}
