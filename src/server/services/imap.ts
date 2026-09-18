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

export async function withImapClient<T>(creds: ImapCredentials, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = createImapClient(creds);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
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
  sinceUid: number
): Promise<{ mailbox: MailboxObject; messages: FetchedMessage[] }> {
  const mailbox = await client.mailboxOpen(folder);

  const messages: FetchedMessage[] = [];
  const range = `${sinceUid + 1}:*`;

  if (mailbox.uidNext !== undefined && mailbox.uidNext <= sinceUid + 1) {
    return { mailbox, messages };
  }

  for await (const message of client.fetch(
    { uid: range },
    { uid: true, size: true, source: true }
  )) {
    if (message.uid <= sinceUid) continue;
    messages.push({ uid: message.uid, size: message.size ?? 0, source: message.source as Buffer });
  }

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
