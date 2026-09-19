import { Database } from "bun:sqlite";
import { decryptSecret, encryptSecret } from "../crypto/secrets";
import { ConflictError, NotFoundError, type Account } from "../types";

interface AccountRow {
  id: number;
  user_id: number;
  email: string;
  display_name: string | null;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  imap_username: string;
  imap_password_encrypted: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  smtp_username: string;
  smtp_password_encrypted: string;
  read_only: number;
  disabled: number;
  skip_soft_delete: number;
  /** NULL = never checked; 0/1 = the server's UIDPLUS support as of the last check (see checkImapCapabilities in services/imap.ts). */
  imap_uidplus: number | null;
  sender_name: string | null;
  signature: string | null;
  position: number;
  /** Path of this account's Sent folder as last seen on the server (learned from the live folder list / a send); NULL = not learned yet. */
  sent_folder: string | null;
  /** JSON `{drafts?, trash?, junk?, archive?}` of the other special folders' real paths, learned the same way — used to keep them out of the combined Inbox. */
  special_folders: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAccountInput {
  email: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  /** When true, this account never has local changes (flags, moves, deletes, sent-mail copies) written back to the IMAP server. */
  readOnly?: boolean;
  /** When true, the account is frozen: no sync, no IMAP/SMTP, no changes to its stored mail — only reading (see assertAccountEnabled). */
  disabled?: boolean;
  /**
   * When true, Delete always permanently expunges instead of moving the message to Trash first —
   * even if the server supports the UIDPLUS extension (see the account's `supportsUidPlus` field,
   * refreshed via checkImapCapabilities) needed for that move to be done safely.
   */
  skipSoftDelete?: boolean;
  /** Used as the From display name on outgoing mail sent from this account, instead of the bare address. */
  senderName?: string;
  /** Markdown, appended to the body of new/reply/forward compositions from this account (not edits of an existing draft). */
  signature?: string;
}

export type UpdateAccountInput = Partial<CreateAccountInput> & {
  /** 1-based place in the account list; the other accounts shift to make room (see setAccountPosition). */
  position?: number;
};

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: !!row.imap_secure,
    imapUsername: row.imap_username,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: !!row.smtp_secure,
    smtpUsername: row.smtp_username,
    readOnly: !!row.read_only,
    disabled: !!row.disabled,
    skipSoftDelete: !!row.skip_soft_delete,
    supportsUidPlus: row.imap_uidplus === null ? null : !!row.imap_uidplus,
    senderName: row.sender_name,
    signature: row.signature,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAccount(db: Database, userId: number, input: CreateAccountInput, encryptionKey: Buffer): Account {
  const row = db
    .query<
      AccountRow,
      [
        number, string, string | null, string, number, number, string, string, string, number, number, string, string,
        number, number, string | null, string | null,
      ]
    >(
      `INSERT INTO accounts (
        user_id, email, display_name,
        imap_host, imap_port, imap_secure, imap_username, imap_password_encrypted,
        smtp_host, smtp_port, smtp_secure, smtp_username, smtp_password_encrypted, read_only, skip_soft_delete,
        sender_name, signature, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT COALESCE(MAX(position), 0) + 1 FROM accounts WHERE user_id = ?1))
      RETURNING *`
    )
    .get(
      userId,
      input.email,
      input.displayName ?? null,
      input.imapHost,
      input.imapPort,
      input.imapSecure ? 1 : 0,
      input.imapUsername,
      encryptSecret(input.imapPassword, encryptionKey),
      input.smtpHost,
      input.smtpPort,
      input.smtpSecure ? 1 : 0,
      input.smtpUsername,
      encryptSecret(input.smtpPassword, encryptionKey),
      input.readOnly ? 1 : 0,
      input.skipSoftDelete ? 1 : 0,
      input.senderName ?? null,
      input.signature ?? null
    );

  return toAccount(row!);
}

export function listAccounts(db: Database, userId: number): Account[] {
  const rows = db.query<AccountRow, [number]>("SELECT * FROM accounts WHERE user_id = ? ORDER BY position, id").all(userId);
  return rows.map(toAccount);
}

export function getAccountRow(db: Database, id: number): AccountRow {
  const row = db.query<AccountRow, [number]>("SELECT * FROM accounts WHERE id = ?").get(id);
  if (!row) throw new NotFoundError(`Account ${id} not found`);
  return row;
}

export function getAccount(db: Database, id: number): Account {
  return toAccount(getAccountRow(db, id));
}

export function getAccountByEmail(db: Database, userId: number, email: string): AccountRow {
  const row = db
    .query<AccountRow, [number, string]>("SELECT * FROM accounts WHERE user_id = ? AND email = ?")
    .get(userId, email);
  if (!row) throw new NotFoundError(`Account "${email}" not found`);
  return row;
}

export function updateAccount(db: Database, id: number, input: UpdateAccountInput, encryptionKey: Buffer): Account {
  const existing = getAccountRow(db, id);

  const imapConnectionChanged =
    (input.imapHost !== undefined && input.imapHost !== existing.imap_host) ||
    (input.imapPort !== undefined && input.imapPort !== existing.imap_port) ||
    (input.imapSecure !== undefined && (input.imapSecure ? 1 : 0) !== existing.imap_secure) ||
    (input.imapUsername !== undefined && input.imapUsername !== existing.imap_username) ||
    input.imapPassword !== undefined;

  const merged: AccountRow = {
    ...existing,
    email: input.email ?? existing.email,
    display_name: input.displayName ?? existing.display_name,
    imap_host: input.imapHost ?? existing.imap_host,
    imap_port: input.imapPort ?? existing.imap_port,
    imap_secure: input.imapSecure !== undefined ? (input.imapSecure ? 1 : 0) : existing.imap_secure,
    imap_username: input.imapUsername ?? existing.imap_username,
    imap_password_encrypted:
      input.imapPassword !== undefined ? encryptSecret(input.imapPassword, encryptionKey) : existing.imap_password_encrypted,
    smtp_host: input.smtpHost ?? existing.smtp_host,
    smtp_port: input.smtpPort ?? existing.smtp_port,
    smtp_secure: input.smtpSecure !== undefined ? (input.smtpSecure ? 1 : 0) : existing.smtp_secure,
    smtp_username: input.smtpUsername ?? existing.smtp_username,
    smtp_password_encrypted:
      input.smtpPassword !== undefined ? encryptSecret(input.smtpPassword, encryptionKey) : existing.smtp_password_encrypted,
    read_only: input.readOnly !== undefined ? (input.readOnly ? 1 : 0) : existing.read_only,
    disabled: input.disabled !== undefined ? (input.disabled ? 1 : 0) : existing.disabled,
    skip_soft_delete: input.skipSoftDelete !== undefined ? (input.skipSoftDelete ? 1 : 0) : existing.skip_soft_delete,
    // A cached "does this server support UIDPLUS" answer is only valid for the server it was
    // checked against — if the connection details changed, forget it until checkImapCapabilities
    // (services/imap.ts) re-checks the (possibly different) server on the next opportunity.
    imap_uidplus: imapConnectionChanged ? null : existing.imap_uidplus,
    sender_name: input.senderName !== undefined ? input.senderName : existing.sender_name,
    signature: input.signature !== undefined ? input.signature : existing.signature,
  };

  const row = db
    .query<
      AccountRow,
      [
        string, string | null, string, number, number, string, string, string, number, number, string, string, number,
        number, number, number | null, string | null, string | null, number,
      ]
    >(
      `UPDATE accounts SET
        email = ?, display_name = ?,
        imap_host = ?, imap_port = ?, imap_secure = ?, imap_username = ?, imap_password_encrypted = ?,
        smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_username = ?, smtp_password_encrypted = ?, read_only = ?,
        disabled = ?, skip_soft_delete = ?, imap_uidplus = ?, sender_name = ?, signature = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
      RETURNING *`
    )
    .get(
      merged.email,
      merged.display_name,
      merged.imap_host,
      merged.imap_port,
      merged.imap_secure,
      merged.imap_username,
      merged.imap_password_encrypted,
      merged.smtp_host,
      merged.smtp_port,
      merged.smtp_secure,
      merged.smtp_username,
      merged.smtp_password_encrypted,
      merged.read_only,
      merged.disabled,
      merged.skip_soft_delete,
      merged.imap_uidplus,
      merged.sender_name,
      merged.signature,
      id
    );

  if (input.position !== undefined) return setAccountPosition(db, id, input.position);
  return toAccount(row!);
}

/** Renumbers a user's accounts 1..n in their current (position, id) order, closing any gaps/ties. */
function renumberAccounts(db: Database, orderedIds: number[]): void {
  const stmt = db.query("UPDATE accounts SET position = ? WHERE id = ?");
  db.transaction(() => {
    orderedIds.forEach((accountId, index) => stmt.run(index + 1, accountId));
  })();
}

/**
 * Moves an account to `position` (1-based, clamped to the valid range) in its user's list; the
 * accounts in between shift by one, so positions always stay a gap-free 1..n.
 */
export function setAccountPosition(db: Database, id: number, position: number): Account {
  const account = getAccountRow(db, id);
  const ids = db
    .query<{ id: number }, [number]>("SELECT id FROM accounts WHERE user_id = ? ORDER BY position, id")
    .all(account.user_id)
    .map(r => r.id)
    .filter(other => other !== id);

  const index = Math.min(Math.max(Math.round(position) - 1, 0), ids.length);
  ids.splice(index, 0, id);
  renumberAccounts(db, ids);
  return getAccount(db, id);
}

/** Startup fix-up: existing databases have position 0 everywhere — this gives every user's accounts a clean 1..n. */
export function normalizeAccountPositions(db: Database): void {
  const users = db.query<{ user_id: number }, []>("SELECT DISTINCT user_id FROM accounts").all();
  for (const { user_id } of users) {
    const ids = db
      .query<{ id: number; position: number }, [number]>("SELECT id, position FROM accounts WHERE user_id = ? ORDER BY position, id")
      .all(user_id);
    if (ids.every((row, i) => row.position === i + 1)) continue;
    renumberAccounts(db, ids.map(r => r.id));
  }
}

/** Remembers where this account's Sent folder lives on the server, so the unified Sent view can find it without an IMAP round trip. */
export function setSentFolder(db: Database, id: number, path: string): void {
  db.query("UPDATE accounts SET sent_folder = ? WHERE id = ? AND (sent_folder IS NOT ?)").run(path, id, path);
}

/** Persists the result of the last UIDPLUS capability check (see checkImapCapabilities in services/imap.ts). */
export function setImapUidPlus(db: Database, id: number, supported: boolean): Account {
  const row = db
    .query<AccountRow, [number, number]>(
      `UPDATE accounts SET imap_uidplus = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *`
    )
    .get(supported ? 1 : 0, id);
  if (!row) throw new NotFoundError(`Account ${id} not found`);
  return toAccount(row);
}

export function deleteAccount(db: Database, id: number): void {
  const existing = getAccountRow(db, id);
  db.query("DELETE FROM accounts WHERE id = ?").run(id);
  // Close the gap the deleted account leaves in the position order.
  renumberAccounts(
    db,
    db.query<{ id: number }, [number]>("SELECT id FROM accounts WHERE user_id = ? ORDER BY position, id").all(existing.user_id).map(r => r.id)
  );
}

export interface DecryptedAccountCredentials {
  imapPassword: string;
  smtpPassword: string;
}

export function decryptAccountCredentials(row: AccountRow, encryptionKey: Buffer): DecryptedAccountCredentials {
  return {
    imapPassword: decryptSecret(row.imap_password_encrypted, encryptionKey),
    smtpPassword: decryptSecret(row.smtp_password_encrypted, encryptionKey),
  };
}

export type { AccountRow };

const SPECIAL_USE_KEYS: Record<string, string> = {
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
};

/**
 * Learns where an account's special folders (Sent, Drafts, Trash, Junk, Archive) actually live
 * from a live IMAP folder listing — names vary per server and language, and the local database
 * only knows folder paths, not what they're for. Only what the listing names is updated.
 */
export function learnSpecialFolders(db: Database, id: number, folders: { path: string; specialUse: string | null }[]): void {
  const sent = folders.find(f => f.specialUse === "\\Sent");
  if (sent) setSentFolder(db, id, sent.path);

  const found: Record<string, string> = {};
  for (const folder of folders) {
    const key = folder.specialUse ? SPECIAL_USE_KEYS[folder.specialUse] : undefined;
    if (key) found[key] = folder.path;
  }
  if (Object.keys(found).length === 0) return;

  const existing = db.query<{ special_folders: string | null }, [number]>("SELECT special_folders FROM accounts WHERE id = ?").get(id);
  let merged: Record<string, string> = {};
  try {
    merged = existing?.special_folders ? JSON.parse(existing.special_folders) : {};
  } catch {}
  merged = { ...merged, ...found };
  db.query("UPDATE accounts SET special_folders = ? WHERE id = ?").run(JSON.stringify(merged), id);
}

/**
 * Guards everything that would change a disabled account or its stored mail — sync, IMAP/SMTP, flags, moves,
 * deletes, drafts, attachments, AI results — with a 409. A disabled account is frozen: it can still be read
 * (lists, messages, attachments, search) and re-enabled or removed in the account settings.
 */
export function assertAccountEnabled(account: { email: string; disabled: number | boolean }): void {
  if (account.disabled) throw new ConflictError(`Account "${account.email}" is disabled. Enable it in its account settings to change it.`);
}

/** Fresh check for long-running work (a sync) that must stop when the account gets disabled meanwhile. */
export function isAccountDisabled(db: Database, id: number): boolean {
  return !!db.query<{ disabled: number }, [number]>("SELECT disabled FROM accounts WHERE id = ?").get(id)?.disabled;
}
