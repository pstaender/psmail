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
