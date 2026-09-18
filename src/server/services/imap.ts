import { ImapFlow, type MailboxObject } from "imapflow";

export interface ImapCredentials {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export function createImapClient(creds: ImapCredentials): ImapFlow {
  return new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
  });
}

/**
 * Runs `fn()`, then always runs `teardown()` afterward — but a teardown failure (however it
 * fails) never overrides `fn`'s own result or error. A plain `try { return await fn() }
 * finally { await teardown() }` gets this wrong: a rejected `finally` block replaces a
 * successful return from `try` with its own error. That matters here because `fn` (e.g.
 * deleteMessage inside performDelete) may have already updated the local database before
 * teardown ever runs — if teardown's failure were allowed to surface as this call's result,
 * a caller that's fail-closed on error (leave local state alone if the push failed) would
 * wrongly leave the database changed while reporting the request as failed. Kept
 * dependency-free (no IMAP types) so it's directly unit-testable; `teardown` is expected to
 * handle its own failures internally and never reject, but this still holds even if it does.
 */
export async function runWithTeardown<T>(fn: () => Promise<T>, teardown: () => Promise<void>): Promise<T> {
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await teardown().catch(() => {});
    throw error;
  }
  await teardown().catch(() => {});
  return result;
}

export async function withImapClient<T>(creds: ImapCredentials, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = createImapClient(creds);
  await client.connect();

  return runWithTeardown(
    () => fn(client),
    async () => {
      await client.logout().catch(() => {
        try {
          client.close();
        } catch {
          // Best-effort teardown — see the doc comment above.
        }
      });
    }
  );
}

export interface ImapFolder {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string | null;
  flags: string[];
}

export async function listFolders(client: ImapFlow): Promise<ImapFolder[]> {
  const list = await client.list();
  return list.map(entry => ({
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter,
    specialUse: entry.specialUse ?? null,
    flags: Array.from(entry.flags ?? []),
  }));
}

export interface FetchedMessage {
  uid: number;
  size: number;
  source: Buffer;
}

/**
 * Opens `folder` and fetches every message whose UID is greater than
 * `sinceUid`, in ascending order. Used for incremental sync.
 */
export async function fetchNewMessages(
  client: ImapFlow,
  folder: string,
  sinceUid: number,
  log: (message: string) => void = () => {}
): Promise<{ mailbox: MailboxObject; messages: FetchedMessage[] }> {
  log(`opening folder "${folder}"`);
  const mailbox = await client.mailboxOpen(folder);
  log(`opened: ${mailbox.exists} message(s) in folder, uidNext=${mailbox.uidNext}, uidValidity=${mailbox.uidValidity}`);

  const messages: FetchedMessage[] = [];
  const range = `${sinceUid + 1}:*`;

  if (mailbox.uidNext !== undefined && mailbox.uidNext <= sinceUid + 1) {
    log(`nothing to fetch (uidNext ${mailbox.uidNext} <= ${sinceUid + 1})`);
    return { mailbox, messages };
  }

  log(`downloading full sources for UID range ${range}`);
  let bytes = 0;
  const heartbeat = setInterval(
    () => log(`still downloading: ${messages.length} message(s), ${(bytes / 1048576).toFixed(1)} MB so far`),
    10_000
  );
  try {
    for await (const message of client.fetch(
      { uid: range },
      { uid: true, size: true, source: true }
    )) {
      if (message.uid <= sinceUid) continue;
      messages.push({ uid: message.uid, size: message.size ?? 0, source: message.source as Buffer });
      bytes += message.size ?? 0;
    }
  } finally {
    clearInterval(heartbeat);
  }
  log(`download finished: ${messages.length} message(s), ${(bytes / 1048576).toFixed(1)} MB`);

  messages.sort((a, b) => a.uid - b.uid);
  return { mailbox, messages };
}

export interface FlagChanges {
  seen?: boolean;
  flagged?: boolean;
}

/** Adds/removes \Seen and/or \Flagged on one message, by UID. Only the flags actually present in `changes` are touched. */
export async function setMessageFlags(client: ImapFlow, folder: string, uid: number, changes: FlagChanges): Promise<void> {
  await client.mailboxOpen(folder);

  const toAdd: string[] = [];
  const toRemove: string[] = [];
  if (changes.seen === true) toAdd.push("\\Seen");
  if (changes.seen === false) toRemove.push("\\Seen");
  if (changes.flagged === true) toAdd.push("\\Flagged");
  if (changes.flagged === false) toRemove.push("\\Flagged");

  if (toAdd.length > 0) {
    const ok = await client.messageFlagsAdd([uid], toAdd, { uid: true });
    if (!ok) throw new Error(`Failed to add flags [${toAdd.join(", ")}] to UID ${uid} in "${folder}"`);
  }
  if (toRemove.length > 0) {
    const ok = await client.messageFlagsRemove([uid], toRemove, { uid: true });
    if (!ok) throw new Error(`Failed to remove flags [${toRemove.join(", ")}] from UID ${uid} in "${folder}"`);
  }
}

/** Permanently deletes one message by UID: flags it \Deleted and expunges (imapflow's messageDelete does both). */
export async function deleteMessage(client: ImapFlow, folder: string, uid: number): Promise<void> {
  await client.mailboxOpen(folder);
  const ok = await client.messageDelete([uid], { uid: true });
  if (!ok) throw new Error(`Failed to delete UID ${uid} in "${folder}"`);
}

export interface MoveResult {
  /** The message's new UID in the destination folder, when the server reported one (most do, via UIDPLUS/COPYUID). */
  newUid: number | null;
}

/** Moves one message by UID into `destination` (via IMAP MOVE, or imapflow's COPY+expunge fallback if the server lacks it). */
export async function moveMessage(client: ImapFlow, folder: string, uid: number, destination: string): Promise<MoveResult> {
  await client.mailboxOpen(folder);
  const result = await client.messageMove([uid], destination, { uid: true });
  if (!result) throw new Error(`Failed to move UID ${uid} from "${folder}" to "${destination}"`);

  const newUid = result.uidMap?.get(uid);
  return { newUid: newUid !== undefined ? Number(newUid) : null };
}

/** Whether the connected server advertises the UIDPLUS extension (RFC 4315). */
export function hasUidPlusCapability(client: ImapFlow): boolean {
  return client.capabilities.has("UIDPLUS");
}

/** Connects just long enough to read the server's advertised capabilities. */
export async function checkImapCapabilities(creds: ImapCredentials): Promise<{ uidPlus: boolean }> {
  return withImapClient(creds, async client => ({ uidPlus: hasUidPlusCapability(client) }));
}

export interface RemoteFlagState {
  seen: boolean;
  flagged: boolean;
}

/**
 * Fetches the current \Seen/\Flagged state of exactly the given UIDs, for reconciling local
 * flags with changes made by other IMAP clients (two-way sync). A UID missing from the
 * returned map is no longer in `folder` on the server — deleted, expunged, or moved elsewhere
 * by another client — which the caller treats as "gone".
 */
export async function fetchRemoteFlags(client: ImapFlow, folder: string, uids: number[]): Promise<Map<number, RemoteFlagState>> {
  const result = new Map<number, RemoteFlagState>();
  if (uids.length === 0) return result;

  await client.mailboxOpen(folder);
  for await (const message of client.fetch({ uid: uids.join(",") }, { uid: true, flags: true })) {
    const flags = message.flags ?? new Set<string>();
    result.set(message.uid, { seen: flags.has("\\Seen"), flagged: flags.has("\\Flagged") });
  }
  return result;
}

export interface AppendResult {
  /** The appended message's UID, when the server reported one (needs UIDPLUS); null otherwise. */
  uid: number | null;
}

/** Appends a raw RFC822 message to `folder` — used to leave a copy of a sent message on the server, since SMTP delivery alone never does. */
export async function appendMessage(client: ImapFlow, folder: string, source: Buffer, flags: string[] = []): Promise<AppendResult> {
  const result = await client.append(folder, source, flags);
  if (!result) throw new Error(`Failed to append message to "${folder}"`);
  return { uid: result.uid !== undefined ? Number(result.uid) : null };
}
