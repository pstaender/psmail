import { Database } from "bun:sqlite";
import type { EmailAddress } from "../types";

export interface Contact {
  address: string;
  name: string;
  fromCount: number;
  ccCount: number;
  sentCount: number;
  lastUsed: string;
  /** True for a suggestion that comes from another of the user's accounts (only with `includeOtherAccounts`). */
  other?: boolean;
}

/** Lower-cases and reduces text to its words (letters/digits of any script) separated by single spaces — so `'First Lastname'` and `first-lastname` are both just "first lastname". */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A display name without the quotes some mail programs wrap around it (`'First Lastname'`, `"Last, First"`). */
export function tidyDisplayName(name: string): string {
  return name.trim().replace(/^['"‘’“”\s]+|['"‘’“”\s]+$/g, "");
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
      const name = tidyDisplayName(entry.name ?? "");
      stmt.run(accountId, address, name, normalizeSearchText(name), fromCount, ccCount, sentCount, when);
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
  /** Also suggest matches from the user's other accounts, after this account's own (see `otherLimit`). */
  includeOtherAccounts?: boolean;
  otherLimit?: number;
}

interface ContactRow {
  address: string;
  name: string;
  from_count: number;
  cc_count: number;
  sent_count: number;
  last_used: string;
}

function toContact(row: ContactRow, other = false): Contact {
  return {
    address: row.address,
    name: row.name,
    fromCount: row.from_count,
    ccCount: row.cc_count,
    sentCount: row.sent_count,
    lastUsed: row.last_used,
    ...(other ? { other: true } : {}),
  };
}

/**
 * The WHERE condition (on a `contacts` row aliased `c`) for a typed query, with its bindings: the address
 * starts with what was typed, OR every word typed is the start of some word of the display name. Words are
 * compared in normalized form (see normalizeSearchText), so punctuation around a name never matters and
 * "last first" finds "First Lastname" too. No query = everything.
 */
function matchCondition(query: string): { sql: string; params: string[] } {
  const q = query.trim().toLowerCase();
  if (q === "") return { sql: "1", params: [] };

  const words = normalizeSearchText(q).split(" ").filter(Boolean).slice(0, 5);
  const nameSql = words.map(() => "instr(' ' || c.name_lc, ' ' || ?) > 0").join(" AND ");
  const addressSql = "(c.address >= ? AND c.address < ?)";
  return {
    sql: words.length > 0 ? `(${addressSql} OR (${nameSql}))` : addressSql,
    params: [q, q + "\uffff", ...words],
  };
}

const RANK_BY_CLOSENESS = `CASE WHEN SUM(c.from_count) > 0 THEN 0 WHEN SUM(c.cc_count) > 0 THEN 1 ELSE 2 END,
                SUM(c.from_count + c.cc_count + c.sent_count) DESC, MAX(c.last_used) DESC`;

/**
 * Autocomplete candidates whose address starts with `query`, or whose display name has words starting
 * with it. Ordered: people who have written to you first, then people who were Cc'd on your mail, then
 * everyone else (people you've only sent to) — and within each group by how often they appear, then how
 * recently. The address range scan runs on the primary key; the name check only touches the account's own
 * rows, so the query stays a couple of milliseconds even for tens of thousands of contacts.
 *
 * With `includeOtherAccounts`, matches from the user's other accounts follow — ranked the same way (an
 * address seen in several accounts counts once, with its numbers added up), never repeating an address
 * this account already knows, and capped separately so they can't crowd out this account's own.
 */
export function suggestContacts(db: Database, accountId: number, query: string, options: SuggestOptions = {}): Contact[] {
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 25);
  const match = matchCondition(query);

  const own = db
    .query<ContactRow, (string | number)[]>(
      `SELECT c.address, c.name, c.from_count, c.cc_count, c.sent_count, c.last_used FROM contacts c
       WHERE c.account_id = ? AND ${match.sql}
       GROUP BY c.address
       ORDER BY ${RANK_BY_CLOSENESS}
       LIMIT ?`
    )
    .all(accountId, ...match.params, limit)
    .map(row => toContact(row));

  if (!options.includeOtherAccounts) return own;

  const otherLimit = Math.min(Math.max(options.otherLimit ?? 5, 1), 25);
  const others = db
    .query<ContactRow, (string | number)[]>(
      `SELECT c.address, MAX(c.name) AS name, SUM(c.from_count) AS from_count, SUM(c.cc_count) AS cc_count,
              SUM(c.sent_count) AS sent_count, MAX(c.last_used) AS last_used
       FROM contacts c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = (SELECT user_id FROM accounts WHERE id = ?1) AND c.account_id != ?1 AND ${match.sql}
         AND NOT EXISTS (SELECT 1 FROM contacts mine WHERE mine.account_id = ?1 AND mine.address = c.address)
       GROUP BY c.address
       ORDER BY ${RANK_BY_CLOSENESS}
       LIMIT ?`
    )
    .all(accountId, ...match.params, otherLimit)
    .map(row => toContact(row, true));

  return [...own, ...others];
}

/**
 * Startup tidy-up for contacts stored before names were normalized: strips quotes wrapped around display
 * names and rebuilds the searchable form, so an old `'First Lastname'` is found by typing "First".
 */
export function tidyContactNames(db: Database): void {
  const rows = db.query<{ account_id: number; address: string; name: string; name_lc: string }, []>("SELECT account_id, address, name, name_lc FROM contacts").all();
  const update = db.query("UPDATE contacts SET name = ?, name_lc = ? WHERE account_id = ? AND address = ?");
  db.transaction(() => {
    for (const row of rows) {
      const name = tidyDisplayName(row.name);
      const nameLc = normalizeSearchText(name);
      if (name !== row.name || nameLc !== row.name_lc) update.run(name, nameLc, row.account_id, row.address);
    }
  })();
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
