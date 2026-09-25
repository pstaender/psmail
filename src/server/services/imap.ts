import { ImapFlow, type MailboxObject } from "imapflow";

export interface ImapCredentials {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export function createImapClient(creds: ImapCredentials): ImapFlow {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
    // Fail with an error instead of waiting for imapflow's defaults (90 s to connect); a slow-but-working server
    // still has the socket timeout (5 min) between commands.
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
  });
  // imapflow emits "error" for a connection that breaks between commands; an EventEmitter without a listener turns
  // that into an uncaught exception that can take a whole request down with it. The pending command's own promise
  // already rejects with the same error, which is what callers handle.
  client.on("error", () => {});
  return client;
}

/** imapflow errors carry the server's actual complaint in fields beyond `message` (which is often just "Command failed"). */
export function describeImapError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & { code?: string; reason?: string; responseStatus?: string; responseText?: string; serverResponseCode?: string; authenticationFailed?: boolean };
  const details = [
    extra.code && `code=${extra.code}`,
    // What the server said just before hanging up ("Account exceeded command or bandwidth limits."): with a bare
    // "Unexpected close" as the message, this is the only place the actual reason is.
    extra.reason && `server said: "${extra.reason}"`,
    extra.responseStatus && `status=${extra.responseStatus}`,
    extra.serverResponseCode && `serverCode=${extra.serverResponseCode}`,
    extra.responseText && `response="${extra.responseText}"`,
    extra.authenticationFailed && "authenticationFailed",
  ].filter(Boolean);
  const text = details.length > 0 ? `${error.message} (${details.join(", ")})` : error.message;
  // Gmail and others throttle accounts that download a lot; it clears by itself after a while.
  return /exceeded .*limit/i.test(extra.reason ?? "") ? `${text} — the mail server is throttling this account; it usually lifts after some hours without heavy use` : text;
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
  return applySpecialUseFallback(
    list.map(entry => ({
      path: entry.path,
      name: entry.name,
      delimiter: entry.delimiter,
      specialUse: entry.specialUse ?? null,
      flags: Array.from(entry.flags ?? []),
    }))
  );
}

/** What a folder name may not contain: the IMAP wildcards, control characters — and the hierarchy delimiter (checked separately). */
const FORBIDDEN_IN_FOLDER_NAME = /[\u0000-\u001f\u007f*%]/;

/** Thrown for a folder name/parent that can't be created; carries the reason for the user and whether it already exists. */
export class FolderNameError extends Error {
  constructor(message: string, readonly kind: "invalid" | "exists" | "missing-parent") {
    super(message);
  }
}

/**
 * Where a new folder goes: `parent` + delimiter + name, or at the top level. Servers that keep everything under
 * the Inbox namespace (Dovecot with `INBOX.` as prefix) refuse top-level names, so when every other folder is
 * `INBOX<delimiter>…` a "top-level" folder is created there too.
 */
export function newFolderPath(existing: ImapFolder[], name: string, parent: string | null): string {
  const delimiter = existing.find(f => f.path === parent)?.delimiter ?? existing.find(f => f.delimiter)?.delimiter ?? "/";
  const trimmed = name.trim();
  if (!trimmed) throw new FolderNameError("A folder needs a name.", "invalid");
  if (trimmed.length > 100) throw new FolderNameError("The folder name is too long (100 characters at most).", "invalid");
  if (trimmed === "." || trimmed === ".." || FORBIDDEN_IN_FOLDER_NAME.test(trimmed) || trimmed.includes(delimiter)) {
    throw new FolderNameError(`A folder name can't contain "${delimiter}", "*", "%" or control characters.`, "invalid");
  }

  let prefix = "";
  if (parent) {
    if (!existing.some(f => f.path === parent)) throw new FolderNameError(`The folder "${parent}" doesn't exist.`, "missing-parent");
    prefix = parent + delimiter;
  } else {
    const others = existing.filter(f => f.specialUse !== "\\Inbox" && f.path.toUpperCase() !== "INBOX");
    if (others.length > 0 && others.every(f => f.path.toUpperCase().startsWith(`INBOX${delimiter}`))) prefix = `INBOX${delimiter}`;
  }

  const path = prefix + trimmed;
  if (existing.some(f => f.path.toLowerCase() === path.toLowerCase())) {
    throw new FolderNameError(`A folder "${path}" already exists.`, "exists");
  }
  return path;
}

/**
 * Creates a folder on the server (and subscribes to it, so other clients show it too). Returns the new path and the
 * server's folder list afterwards.
 */
export async function createFolder(client: ImapFlow, name: string, parent: string | null): Promise<{ path: string; folders: ImapFolder[] }> {
  const path = newFolderPath(await listFolders(client), name, parent);
  await client.mailboxCreate(path);
  await client.mailboxSubscribe(path).catch(() => {}); // not every server has subscriptions; the folder exists either way
  return { path, folders: await listFolders(client) };
}

/** Where a rename lands: same parent as `folder`, just the last path segment swapped for the new name — the same validation as a new folder's name, minus the collision check against `folder` itself. */
export function renameFolderPath(existing: ImapFolder[], folder: ImapFolder, newName: string): string {
  const trimmed = newName.trim();
  if (!trimmed) throw new FolderNameError("A folder needs a name.", "invalid");
  if (trimmed.length > 100) throw new FolderNameError("The folder name is too long (100 characters at most).", "invalid");
  if (trimmed === "." || trimmed === ".." || FORBIDDEN_IN_FOLDER_NAME.test(trimmed) || (folder.delimiter && trimmed.includes(folder.delimiter))) {
    throw new FolderNameError(`A folder name can't contain "${folder.delimiter}", "*", "%" or control characters.`, "invalid");
  }

  const lastDelimiter = folder.delimiter ? folder.path.lastIndexOf(folder.delimiter) : -1;
  const prefix = lastDelimiter >= 0 ? folder.path.slice(0, lastDelimiter + 1) : "";
  const path = prefix + trimmed;
  if (existing.some(f => f.path !== folder.path && f.path.toLowerCase() === path.toLowerCase())) {
    throw new FolderNameError(`A folder "${path}" already exists.`, "exists");
  }
  return path;
}

/**
 * Renames a folder on the server, keeping it in the same place in the hierarchy (only its own name changes).
 * A no-op (no server round trip) when the new name resolves to the folder's current path. Returns the (possibly
 * unchanged) path and the server's folder list afterwards.
 */
export async function renameFolder(client: ImapFlow, path: string, newName: string): Promise<{ path: string; folders: ImapFolder[] }> {
  const existing = await listFolders(client);
  const folder = existing.find(f => f.path === path);
  if (!folder) throw new FolderNameError(`The folder "${path}" doesn't exist.`, "missing-parent");

  const newPath = renameFolderPath(existing, folder, newName);
  if (newPath === path) return { path, folders: existing };

  await client.mailboxRename(path, newPath);
  return { path: newPath, folders: await listFolders(client) };
}

/**
 * Servers that don't flag their Inbox/Sent folders (no \Inbox / \Sent special-use) usually still name them that way:
 * when no folder carries the flag, a folder called "inbox" / "sent" (any case) is taken for it. A real flag always wins.
 */
export function applySpecialUseFallback<T extends { name: string; specialUse: string | null }>(folders: T[]): T[] {
  let result = folders;
  for (const [use, name] of [["\\Inbox", "inbox"], ["\\Sent", "sent"]] as const) {
    if (result.some(folder => folder.specialUse === use)) continue;
    const match = result.find(folder => folder.specialUse === null && folder.name.toLowerCase() === name);
    if (match) result = result.map(folder => (folder === match ? { ...folder, specialUse: use } : folder));
  }
  return result;
}

/** The Inbox always comes first; everything else keeps its order. */
export function inboxFirst<T extends { specialUse: string | null }>(folders: T[]): T[] {
  return [...folders.filter(folder => folder.specialUse === "\\Inbox"), ...folders.filter(folder => folder.specialUse !== "\\Inbox")];
}

export interface FetchedMessage {
  uid: number;
  size: number;
  source: Buffer;
}

export interface FetchHooks {
  /** Called once the folder is open, with how many messages it holds in total. */
  onOpened?: (exists: number) => void;
  /** Called after each message finishes downloading, with the running count. */
  onDownloaded?: (count: number) => void;
}

/**
 * Opens `folder` and fetches every message whose UID is greater than
 * `sinceUid`, in ascending order. Used for incremental sync.
 */
export async function fetchNewMessages(
  client: ImapFlow,
  folder: string,
  sinceUid: number,
  log: (message: string) => void = () => {},
  hooks: FetchHooks = {}
): Promise<{ mailbox: MailboxObject; messages: FetchedMessage[] }> {
  log(`opening folder "${folder}"`);
  const mailbox = await client.mailboxOpen(folder);
  hooks.onOpened?.(mailbox.exists);
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
    // A range *string* plus {uid: true}: passing `{ uid: range }` instead is a search query,
    // which imapflow answers with UID SEARCH and then a UID FETCH listing every hit — an
    // argument that grows with the mailbox until the server rejects it as too long.
    for await (const message of client.fetch(range, { uid: true, size: true, source: true }, { uid: true })) {
      if (message.uid <= sinceUid) continue;
      messages.push({ uid: message.uid, size: message.size ?? 0, source: message.source as Buffer });
      bytes += message.size ?? 0;
      hooks.onDownloaded?.(messages.length);
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
  /** The `$Forwarded` keyword — many servers allow it, some don't: callers treat it as best effort. */
  forwarded?: true;
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
  if (changes.forwarded === true) toAdd.push("$Forwarded");

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

/** The message's original RFC 822 source, read without changing anything (the folder is opened read-only); null when the server doesn't have it. */
export async function fetchMessageSource(client: ImapFlow, folder: string, uid: number): Promise<Buffer | null> {
  await client.mailboxOpen(folder, { readOnly: true });
  const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
  return message && message.source ? message.source : null;
}

export interface FoundMessage {
  uid: number;
  subject: string | null;
  date: string | null;
  size: number;
}

/**
 * A server-side SEARCH for messages carrying a given Message-ID header, in `folder` — a diagnostic: is a
 * message really on the server, and if so under what UID (the sync's own "newer than my highest known
 * UID" watermark only ever looks forward, so a message whose UID turns out to be lower than what's already
 * stored — an out-of-order append, a folder that was renumbered and only partly re-walked, and the like —
 * would never surface through a normal sync no matter how many times it runs; this is how to tell).
 */
export async function findByMessageId(client: ImapFlow, folder: string, messageId: string): Promise<FoundMessage[]> {
  await client.mailboxOpen(folder, { readOnly: true });
  const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
  if (!uids || uids.length === 0) return [];
  const found: FoundMessage[] = [];
  for await (const message of client.fetch(uids, { uid: true, envelope: true, size: true }, { uid: true })) {
    found.push({ uid: message.uid, subject: message.envelope?.subject ?? null, date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : null, size: message.size ?? 0 });
  }
  return found.sort((a, b) => a.uid - b.uid);
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
  /** The `$Forwarded` keyword is set (optional: a server or a test double that doesn't know it says nothing). */
  forwarded?: boolean;
}

export interface RemoteFlagsResult {
  /** The folder's UIDVALIDITY as of this open — see models/folderValidity.ts for why the caller needs it. */
  uidValidity: number;
  /** A UID missing from this map is no longer in `folder` on the server — deleted, expunged, or moved elsewhere by
   * another client — which the caller treats as "gone", but ONLY once it has confirmed UIDVALIDITY hasn't changed. */
  flags: Map<number, RemoteFlagState>;
}

/**
 * Fetches the current \Seen/\Flagged state of exactly the given UIDs, for reconciling local
 * flags with changes made by other IMAP clients (two-way sync).
 */
export async function fetchRemoteFlags(client: ImapFlow, folder: string, uids: number[]): Promise<RemoteFlagsResult> {
  const mailbox = await client.mailboxOpen(folder);
  const uidValidity = Number(mailbox.uidValidity);
  const flags = new Map<number, RemoteFlagState>();
  if (uids.length === 0) return { uidValidity, flags };

  // A single min:max range string (not `{ uid: ... }`, which imapflow treats as a search whose
  // hits get listed in the UID FETCH) — a list of thousands of UIDs makes servers reject the
  // command ("Too long argument"). Extra UIDs inside the range
  // that we don't track are harmless — the caller only looks up the UIDs it asked about.
  const range = `${Math.min(...uids)}:${Math.max(...uids)}`;
  for await (const message of client.fetch(range, { uid: true, flags: true }, { uid: true })) {
    const messageFlags = message.flags ?? new Set<string>();
    flags.set(message.uid, { seen: messageFlags.has("\\Seen"), flagged: messageFlags.has("\\Flagged"), forwarded: messageFlags.has("$Forwarded") });
  }
  return { uidValidity, flags };
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
