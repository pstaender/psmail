import { Database } from "bun:sqlite";
import { decryptSecret, encryptSecret } from "../crypto/secrets";
import { NotFoundError, type Account } from "../types";

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
}

export type UpdateAccountInput = Partial<CreateAccountInput>;

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAccount(db: Database, userId: number, input: CreateAccountInput, encryptionKey: Buffer): Account {
  const row = db
    .query<
      AccountRow,
      [number, string, string | null, string, number, number, string, string, string, number, number, string, string]
    >(
      `INSERT INTO accounts (
        user_id, email, display_name,
        imap_host, imap_port, imap_secure, imap_username, imap_password_encrypted,
        smtp_host, smtp_port, smtp_secure, smtp_username, smtp_password_encrypted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      encryptSecret(input.smtpPassword, encryptionKey)
    );

  return toAccount(row!);
}

export function listAccounts(db: Database, userId: number): Account[] {
  const rows = db.query<AccountRow, [number]>("SELECT * FROM accounts WHERE user_id = ? ORDER BY id").all(userId);
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
  };

  const row = db
    .query<AccountRow, [string, string | null, string, number, number, string, string, string, number, number, string, string, number]>(
      `UPDATE accounts SET
        email = ?, display_name = ?,
        imap_host = ?, imap_port = ?, imap_secure = ?, imap_username = ?, imap_password_encrypted = ?,
        smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_username = ?, smtp_password_encrypted = ?,
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
      id
    );

  return toAccount(row!);
}

export function deleteAccount(db: Database, id: number): void {
  const result = db.query("DELETE FROM accounts WHERE id = ?").run(id);
  if (result.changes === 0) throw new NotFoundError(`Account ${id} not found`);
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
