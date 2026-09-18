import { Database } from "bun:sqlite";
import type { EmailAddress } from "../types";

export interface Contact {
  address: string;
  name: string;
  fromCount: number;
  ccCount: number;
  sentCount: number;
  lastUsed: string;
}

export interface MailAddressFields {
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  date: string | null;
}

const UPSERT = `
  INSERT INTO contacts (account_id, address, name, name_lc, from_count, cc_count, sent_count, last_used)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(account_id, address) DO UPDATE SET
    from_count = from_count + excluded.from_count,
    cc_count = cc_count + excluded.cc_count,
    sent_count = sent_count + excluded.sent_count,
    name = CASE WHEN excluded.name <> '' AND excluded.last_used >= last_used THEN excluded.name ELSE name END,
    name_lc = CASE WHEN excluded.name <> '' AND excluded.last_used >= last_used THEN excluded.name_lc ELSE name_lc END,
    last_used = MAX(last_used, excluded.last_used)
`;

/**
 * Feeds one stored message into the account's contact list. Received mail counts its sender (`from`)
 * and Cc'd people; outgoing mail counts every recipient. The account's own address is never a contact.
 * `outgoing` is decided by the caller (the message was sent by the account itself).
 */
export function recordContacts(db: Database, accountId: number, ownAddress: string, mail: MailAddressFields, outgoing: boolean): void {
  const own = ownAddress.toLowerCase();
  const when = mail.date ?? new Date().toISOString();
  const stmt = db.query(UPSERT);

  const add = (list: EmailAddress[], fromCount: number, ccCount: number, sentCount: number) => {
    for (const entry of list) {
      const address = entry.address?.trim().toLowerCase();
      if (!address || address === own) continue;
      const name = entry.name?.trim() ?? "";
      stmt.run(accountId, address, name, name.toLowerCase(), fromCount, ccCount, sentCount, when);
    }
  };

  if (outgoing) {
    add(mail.to, 0, 0, 1);
    add(mail.cc, 0, 0, 1);
    add(mail.bcc, 0, 0, 1);
  } else {
    add(mail.from, 1, 0, 0);
    add(mail.cc, 0, 1, 0);
  }
}

export interface SuggestOptions {
  limit?: number;
}

/**
 * Autocomplete candidates whose address starts with `query`, or whose display name has a word starting
 * with it. Ordered: people who have written to you first, then people who were Cc'd on your mail, then
 * everyone else (people you've only sent to) — and within each group by how often they appear, then how
 * recently. The address range scan runs on the primary key; the name check only touches this one
 * account's rows, so the query stays a couple of milliseconds even for tens of thousands of contacts.
 */
export function suggestContacts(db: Database, accountId: number, query: string, options: SuggestOptions = {}): Contact[] {
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 25);
  const q = query.trim().toLowerCase();

  const rows = db
    .query<
      { address: string; name: string; from_count: number; cc_count: number; sent_count: number; last_used: string },
      [number, string, string, number]
    >(
      `SELECT address, name, from_count, cc_count, sent_count, last_used FROM contacts
       WHERE account_id = ?1 AND (?2 = '' OR (address >= ?2 AND address < ?3) OR instr(' ' || name_lc, ' ' || ?2) > 0)
       ORDER BY CASE WHEN from_count > 0 THEN 0 WHEN cc_count > 0 THEN 1 ELSE 2 END,
                (from_count + cc_count + sent_count) DESC, last_used DESC
       LIMIT ?4`
    )
    .all(accountId, q, q + "\uffff", limit);

  return rows.map(r => ({
    address: r.address,
    name: r.name,
    fromCount: r.from_count,
    ccCount: r.cc_count,
    sentCount: r.sent_count,
    lastUsed: r.last_used,
  }));
}

/**
 * One-time backfill for databases that predate the contacts table: if it's empty but mail exists,
 * replays every stored non-draft message through recordContacts. Cheap no-op on every later start.
 */
export function rebuildContactsIfEmpty(db: Database): void {
  const hasContacts = db.query("SELECT 1 FROM contacts LIMIT 1").get();
  if (hasContacts) return;
  const hasMail = db.query("SELECT 1 FROM emails WHERE is_draft = 0 LIMIT 1").get();
  if (!hasMail) return;

  const rows = db
    .query<
      { account_id: number; own: string; from_addr: string | null; to_addr: string | null; cc_addr: string | null; bcc_addr: string | null; date: string | null },
      []
    >(
      `SELECT e.account_id, a.email AS own, e.from_addr, e.to_addr, e.cc_addr, e.bcc_addr, e.date
       FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.is_draft = 0`
    )
    .all();

  const parse = (json: string | null): EmailAddress[] => {
    try {
      return json ? JSON.parse(json) : [];
    } catch {
      return [];
    }
  };

  db.transaction(() => {
    for (const row of rows) {
      const from = parse(row.from_addr);
      const outgoing = from.some(a => a.address?.toLowerCase() === row.own.toLowerCase());
      recordContacts(
        db,
        row.account_id,
        row.own,
        { from, to: parse(row.to_addr), cc: parse(row.cc_addr), bcc: parse(row.bcc_addr), date: row.date },
        outgoing
      );
    }
  })();
}
