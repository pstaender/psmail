/**
 * Calendar events found in a message by the AI, turned into iCalendar (.ics) files.
 *
 * The AI is asked for a plain JSON list of events (title, start, end, place, notes) — models write JSON far more
 * reliably than they write iCalendar — and the VCALENDAR text itself is produced here, so a file always is valid:
 * escaping, line folding, CRLF, dates in the right form.
 */

export interface FoundEvent {
  title: string;
  /** `YYYY-MM-DD` (all day) or `YYYY-MM-DDTHH:MM[:SS]` with an optional `Z` / `+02:00` (a time; without either it is "floating": the same wall-clock time wherever the calendar is). */
  start: string;
  end?: string;
  location?: string;
  description?: string;
}

/** Enough for a mailing list's worth of dates, not enough to flood a calendar because a model went wild. */
export const MAX_EVENTS = 20;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i;

interface ParsedWhen {
  allDay: boolean;
  /** The value as written into the file: `20260930` / `20260930T140000` / `20260930T120000Z`. */
  ics: string;
  /** For ordering and end-after-start checks (a floating time counts as UTC; only comparisons within one event use it). */
  ms: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function validDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function parseWhen(value: unknown): ParsedWhen | null {
  if (typeof value !== "string") return null;
  const text = value.trim();

  const day = DATE_ONLY.exec(text);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    if (!validDate(year, month, date)) return null;
    return { allDay: true, ics: `${pad(year, 4)}${pad(month)}${pad(date)}`, ms: Date.UTC(year, month - 1, date) };
  }

  const time = DATE_TIME.exec(text);
  if (!time) return null;
  const [year, month, date, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(i => Number(time[i] ?? 0));
  if (!validDate(year!, month!, date!) || hour! > 23 || minute! > 59 || second! > 59) return null;

  const zone = time[7];
  const local = Date.UTC(year!, month! - 1, date!, hour!, minute!, second!);
  if (!zone) return { allDay: false, ics: `${pad(year!, 4)}${pad(month!)}${pad(date!)}T${pad(hour!)}${pad(minute!)}${pad(second!)}`, ms: local };

  // A zone was given: the file says it in UTC, which every calendar understands.
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const utc = new Date(local - offsetMinutes * 60_000);
  return {
    allDay: false,
    ics: `${pad(utc.getUTCFullYear(), 4)}${pad(utc.getUTCMonth() + 1)}${pad(utc.getUTCDate())}T${pad(utc.getUTCHours())}${pad(utc.getUTCMinutes())}${pad(utc.getUTCSeconds())}Z`,
    ms: utc.getTime(),
  };
}

const clean = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n?/g, "\n").trim().slice(0, max);
  return text || undefined;
};

/**
 * The events in an AI answer: a JSON array of objects (found inside other text too, or wrapped in a code fence). Entries
 * without a title or with a start that isn't a real date are dropped, as is an end before the start.
 */
export function parseEventsAnswer(answer: string): FoundEvent[] {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const events: FoundEvent[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const title = clean(raw.title ?? raw.summary ?? raw.name, 200);
    const from = parseWhen(raw.start);
    if (!title || !from) continue;

    let until = raw.end === undefined || raw.end === null || raw.end === "" ? null : parseWhen(raw.end);
    if (until && (until.allDay !== from.allDay || until.ms < from.ms)) until = null; // mixed or backwards: leave the end out

    const key = `${title.toLowerCase()}|${from.ics}`;
    if (seen.has(key)) continue;
    seen.add(key);

    events.push({
      title,
      start: String(raw.start).trim(),
      ...(until ? { end: String(raw.end).trim() } : {}),
      ...(clean(raw.location, 300) ? { location: clean(raw.location, 300) } : {}),
      ...(clean(raw.description ?? raw.notes, 2000) ? { description: clean(raw.description ?? raw.notes, 2000) } : {}),
    });
    if (events.length === MAX_EVENTS) break;
  }
  return events;
}

/** iCalendar TEXT escaping (RFC 5545 3.3.11). */
export function escapeIcsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Lines are at most 75 octets; a longer one continues on the next line after a space (never inside a UTF-8 character). */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74; // the continuation line starts with a space
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const stamp = (date: Date) =>
  `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

/** A stable id: the same event found again in the same message gets the same UID, so importing it twice doesn't duplicate it. */
function uidFor(emailId: number, event: FoundEvent): string {
  const hash = Bun.hash(`${event.title.toLowerCase()}|${event.start}`).toString(36);
  return `psmail-${emailId}-${hash}@psmail`;
}

/** One VCALENDAR (with a single VEVENT) for an event found in a message; null when its start isn't a valid date. */
export function buildIcs(event: FoundEvent, emailId: number, now = new Date()): string | null {
  const from = parseWhen(event.start);
  if (!from) return null;
  const until = event.end ? parseWhen(event.end) : null;

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//P.S.Mail//Events found by AI//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT"];
  lines.push(`UID:${uidFor(emailId, event)}`, `DTSTAMP:${stamp(now)}`);

  if (from.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${from.ics}`);
    // An all-day DTEND is exclusive: the day after the last day (one day when no end was given).
    const last = new Date((until && until.allDay ? until.ms : from.ms) + 86_400_000);
    lines.push(`DTEND;VALUE=DATE:${pad(last.getUTCFullYear(), 4)}${pad(last.getUTCMonth() + 1)}${pad(last.getUTCDate())}`);
  } else {
    lines.push(`DTSTART:${from.ics}`);
    if (until && !until.allDay) lines.push(`DTEND:${until.ics}`);
  }

  lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/** The VCALENDARs for an AI answer: one per event found. */
export function icsFromAnswer(answer: string, emailId: number, now = new Date()): string[] {
  return parseEventsAnswer(answer)
    .map(event => buildIcs(event, emailId, now))
    .filter((ics): ics is string => ics !== null);
}
