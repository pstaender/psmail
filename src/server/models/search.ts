import { Database } from "bun:sqlite";
import type { EmailAddress } from "../types";
import { emailIdsWithAttachments } from "./emails";

export interface SearchResult {
  id: number;
  accountEmail: string;
  folder: string;
  uid: number | null;
  isRead: boolean;
  isFlagged: boolean;
  subject: string | null;
  from: EmailAddress[];
  /** Recipients — only filled by the unified Sent list, which shows who a message went to rather than who sent it. */
  to?: EmailAddress[];
  hasAttachments?: boolean;
  date: string | null;
}

interface ParsedQuery {
  generalTerms: string[];
  fromTerms: string[];
  /** Set by a leading `favs` word: only flagged ("favorite") messages match. */
  favsOnly: boolean;
}

/**
 * Splits a query into whitespace-separated tokens, except that a `"..."`
 * span (optionally preceded by a `field:` prefix, e.g. `from:"jane doe"`)
 * is kept as one token with its spaces intact — an exact-phrase match
 * rather than several independent AND'd words.
 */
function tokenizeQuery(query: string): string[] {
  const tokenRe = /([a-zA-Z]+:)?"([^"]*)"|(\S+)/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(query)) !== null) {
    const token = match[2] !== undefined ? `${match[1] ?? ""}${match[2]}` : match[3]!;
    if (token) tokens.push(token);
  }

  return tokens;
}

/**
 * Parses a search query into general terms (ANDed — a bare "amazon
 * gutschein" means "matches amazon AND matches gutschein", independently
 * of order; each term matches if it's found in *either* the subject or the
 * sender, so a bare "amazon" finds mail from amazon.de even when the
 * subject doesn't say "amazon") and `from:` terms (ORed, sender-only). Each
 * term supports `*` as a wildcard; a term with no `*` implicitly matches
 * anywhere, i.e. is wrapped as `*term*`. Quoting a phrase with `"..."` keeps
 * it as a single term instead of splitting it into separate AND'd words.
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const generalTerms: string[] = [];
  const fromTerms: string[] = [];

  // `favs` only counts as a command as the very first word (checked on the raw text, so a quoted
  // "favs" — a phrase to search for — isn't mistaken for it). Everything after it filters as usual:
  // `favs amazon` = flagged messages matching "amazon"; a lone `favs` lists all flagged messages.
  const favsMatch = /^\s*favs(?:\s+|$)/i.exec(query);
  const favsOnly = favsMatch !== null;

  for (const token of tokenizeQuery(favsMatch ? query.slice(favsMatch[0].length) : query)) {
    const fromMatch = /^from:(.+)$/i.exec(token);
    if (fromMatch) fromTerms.push(fromMatch[1]!);
    else generalTerms.push(token);
  }

  return { generalTerms, fromTerms, favsOnly };
}

/**
 * Converts one search term into a case-insensitive regex, unanchored so it
 * matches anywhere in the field rather than requiring the field to start/end
 * exactly at the pattern's edges — "amazon*gutschein" should find "Amazon
 * Gutschein für dich", not just a subject that ends right after "gutschein".
 * Matching runs in JS rather than SQL LIKE/LOWER() specifically because
 * those are ASCII-only in stock SQLite (no ICU extension here) — real
 * mailboxes have plenty of non-ASCII subjects/names, and `i` + `u` flags
 * give correct Unicode case folding.
 */
function wildcardToRegExp(term: string): RegExp {
  const pattern = term.includes("*") ? term : `*${term}*`;
  const escaped = pattern
    .split("*")
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(escaped, "iu");
}

interface SearchRow {
  id: number;
  account_email: string;
  folder: string;
  uid: number | null;
  is_read: number;
  is_flagged: number;
  subject: string | null;
  from_addr: string | null;
  date: string | null;
}

function parseAddresses(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function addressSearchText(addresses: EmailAddress[]): string {
  return addresses.map(a => `${a.name ?? ""} ${a.address}`).join(" ");
}

function toSearchResult(row: SearchRow): SearchResult {
  return {
    id: row.id,
    accountEmail: row.account_email,
    folder: row.folder,
    uid: row.uid,
    isRead: !!row.is_read,
    isFlagged: !!row.is_flagged,
    subject: row.subject,
    from: parseAddresses(row.from_addr),
    date: row.date,
  };
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
}

/**
 * Searches every email across every account the given user owns — not just
 * the currently selected account/folder. A bare term matches if it's found
 * in the subject OR the sender (so `amazon gutscheine fahrrad` behaves like
 * "from has amazon, subject has gutscheine, subject has fahrrad" whenever
 * "amazon" only shows up as a sender and the other words only show up in
 * the subject — but it's really just "each word matches subject-or-from",
 * ANDed together). `from:addr` is a dedicated, sender-only, OR'd filter on
 * top of that. Always case-insensitive.
 */
export function searchEmails(db: Database, userId: number, query: string, options: SearchOptions = {}): SearchResult[] {
  const { generalTerms, fromTerms, favsOnly } = parseSearchQuery(query);
  if (generalTerms.length === 0 && fromTerms.length === 0 && !favsOnly) return [];

  const generalRegexes = generalTerms.map(wildcardToRegExp);
  const fromRegexes = fromTerms.map(wildcardToRegExp);

  const rows = db
    .query<SearchRow, [number]>(
      `SELECT emails.id, accounts.email as account_email, emails.folder, emails.uid,
              emails.is_read, emails.is_flagged, emails.subject, emails.from_addr, emails.date
       FROM emails
       JOIN accounts ON accounts.id = emails.account_id
       WHERE accounts.user_id = ?${favsOnly ? " AND emails.is_flagged = 1" : ""}
       ORDER BY emails.date DESC`
    )
    .all(userId);

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const results: SearchResult[] = [];

  for (const row of rows) {
    const subject = row.subject ?? "";
    const fromText = addressSearchText(parseAddresses(row.from_addr));

    if (!generalRegexes.every(re => re.test(subject) || re.test(fromText))) continue;
    if (fromRegexes.length > 0 && !fromRegexes.some(re => re.test(fromText))) continue;

    results.push(toSearchResult(row));
    if (results.length >= offset + limit) break;
  }

  const page = results.slice(offset, offset + limit);
  const withAttachments = emailIdsWithAttachments(db, page.map(r => r.id));
  return page.map(r => ({ ...r, hasAttachments: withAttachments.has(r.id) }));
}
