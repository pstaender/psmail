import { Database } from "bun:sqlite";
import type { EmailAddress } from "../types";
import { emailIdsWithAttachments, taxonomyListsFor } from "./emails";
import { dateBoundsSql, type DateBounds } from "./dateBounds";

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
  /** Set when the message was found by its text (the fallback when subject and sender matched nothing), not by subject or sender. */
  matchedInBody?: boolean;
  /** The message's categories (AI labels), when it has any. */
  taxonomyList?: string[];
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

/**
 * The same term semantics as wildcardToRegExp (case-insensitive, `*` matches anything, a term without one matches anywhere),
 * for long texts: the parts between the stars are looked up one after the other with indexOf, which stays linear where a
 * regex with `.*` between two words backtracks for seconds on a few KB of text. Takes the text already lower-cased.
 */
function wildcardTextMatcher(term: string): (lowerText: string) => boolean {
  const parts = term.toLowerCase().split("*").filter(part => part !== "");
  return lowerText => {
    let from = 0;
    for (const part of parts) {
      const at = lowerText.indexOf(part, from);
      if (at === -1) return false;
      from = at + part.length;
    }
    return true;
  };
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

/**
 * How many of the newest messages (of the user, over all accounts) the text fallback reads at most, and how much of each
 * message's text. Reading message bodies is the expensive part of a search — the header search only touches two short
 * columns — so it is bounded: at worst about 20 000 bodies of up to 100 000 characters, and it stops at the first page of hits.
 */
export const BODY_SEARCH_MAX_MESSAGES = 20_000;
const BODY_SEARCH_MAX_CHARS = 100_000;
const BODY_CHUNK = 200;

/**
 * The fallback for a search that found nothing in subjects and senders: the same terms (each must be in the subject, the
 * sender or the plain text of the message; `from:` terms still restrict the sender), newest first. Texts are read in chunks
 * and the scan ends as soon as `wanted` messages matched, so a query that does hit is cheap and only a query that hits nothing
 * reads everything (up to the limit above). Plain text only: a message that has just an HTML part isn't searched here.
 */
function searchBodies(
  db: Database,
  userId: number,
  { generalTerms, generalRegexes, fromRegexes, favsOnly, window }: { generalTerms: string[]; generalRegexes: RegExp[]; fromRegexes: RegExp[]; favsOnly: boolean; window: DateBounds },
  wanted: number
): SearchResult[] {
  // The newest messages first, without their texts: sorting rows that carry long bodies is what made this slow.
  const dates = dateBoundsSql(window, "emails.date");
  const headers = db
    .query<SearchRow, (string | number)[]>(
      `SELECT emails.id, accounts.email as account_email, emails.folder, emails.uid,
              emails.is_read, emails.is_flagged, emails.subject, emails.from_addr, emails.date
       FROM emails
       JOIN accounts ON accounts.id = emails.account_id
       WHERE accounts.user_id = ? AND emails.plain_text IS NOT NULL${favsOnly ? " AND emails.is_flagged = 1" : ""}${dates.sql}
       ORDER BY emails.date DESC
       LIMIT ?`
    )
    .all(userId, ...dates.params, BODY_SEARCH_MAX_MESSAGES);

  // Then the texts, a chunk at a time, so that a query that has enough hits stops after reading only as many as it needed.
  const bodyMatchers = generalTerms.map(wildcardTextMatcher);
  const found: SearchResult[] = [];
  for (let start = 0; start < headers.length && found.length < wanted; start += BODY_CHUNK) {
    const chunk = headers.slice(start, start + BODY_CHUNK);
    const bodies = new Map(
      db
        .query<{ id: number; body: string | null }, number[]>(
          `SELECT id, substr(plain_text, 1, ${BODY_SEARCH_MAX_CHARS}) AS body FROM emails WHERE id IN (${chunk.map(() => "?").join(",")})`
        )
        .all(...chunk.map(row => row.id))
        .map(row => [row.id, row.body ?? ""] as const)
    );

    for (const row of chunk) {
      const fromText = addressSearchText(parseAddresses(row.from_addr));
      if (fromRegexes.length > 0 && !fromRegexes.some(re => re.test(fromText))) continue;

      const subject = row.subject ?? "";
      const lowerBody = (bodies.get(row.id) ?? "").toLowerCase();
      if (!generalRegexes.every((re, i) => re.test(subject) || re.test(fromText) || bodyMatchers[i]!(lowerBody))) continue;

      found.push({ ...toSearchResult(row), matchedInBody: true });
      if (found.length >= wanted) break;
    }
  }
  return found;
}

export interface SearchOptions extends DateBounds {
  limit?: number;
  offset?: number;
  /** Always search the message text too, not only when subject and sender found nothing. */
  fullText?: boolean;
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

  // A date window (the list's date filter) narrows what is looked at in the first place: search "as before", but only there.
  const window: DateBounds = { after: options.after, before: options.before };
  const dates = dateBoundsSql(window, "emails.date");
  const rows = db
    .query<SearchRow, (string | number)[]>(
      `SELECT emails.id, accounts.email as account_email, emails.folder, emails.uid,
              emails.is_read, emails.is_flagged, emails.subject, emails.from_addr, emails.date
       FROM emails
       JOIN accounts ON accounts.id = emails.account_id
       WHERE accounts.user_id = ?${favsOnly ? " AND emails.is_flagged = 1" : ""}${dates.sql}
       ORDER BY emails.date DESC`
    )
    .all(userId, ...dates.params);

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

  if (generalTerms.length > 0) {
    if (options.fullText) {
      // Full text search: the message text is always part of it. Each term still has to be in the subject, the sender or
      // the text, so the text pass finds everything the subject/sender pass did (and more): merge the two, newest first.
      const inText = searchBodies(db, userId, { generalTerms, generalRegexes, fromRegexes, favsOnly, window }, offset + limit);
      const byId = new Map<number, SearchResult>();
      for (const result of [...inText, ...results]) byId.set(result.id, result); // a header match wins over "in the text"
      results.length = 0;
      results.push(...[...byId.values()].sort((a, b) => ((a.date ?? "") === (b.date ?? "") ? b.id - a.id : (a.date ?? "") < (b.date ?? "") ? 1 : -1)));
    } else if (results.length === 0) {
      // Nothing matched subject or sender: look in the message text too.
      results.push(...searchBodies(db, userId, { generalTerms, generalRegexes, fromRegexes, favsOnly, window }, offset + limit));
    }
  }

  const page = results.slice(offset, offset + limit);
  const withAttachments = emailIdsWithAttachments(db, page.map(r => r.id));
  const categories = taxonomyListsFor(db, page.map(r => r.id));
  return page.map(r => ({ ...r, hasAttachments: withAttachments.has(r.id), ...(categories.has(r.id) ? { taxonomyList: categories.get(r.id) } : {}) }));
}
