/**
 * The date filter of a message list, as the user sets it (days, in their own time zone) and as the server takes it
 * (`after` inclusive / `before` exclusive, ISO instants — see server/models/dateBounds.ts).
 */
export type DateFilter =
  | { mode: "day"; day: string }
  | { mode: "range"; from: string; to: string }
  | { mode: "before"; day: string }
  | { mode: "since"; day: string };

export type DateFilterMode = DateFilter["mode"];

export interface DateBoundsQuery {
  after?: string;
  before?: string;
}

export const MODE_LABELS: Record<DateFilterMode, string> = {
  day: "Specific day",
  range: "Date range",
  since: "Since a date",
  before: "Before a date",
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight of `YYYY-MM-DD` (or of the day `plusDays` later); null when it isn't a real date. */
function localMidnight(day: string, plusDays = 0): Date | null {
  const match = DAY.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = new Date(year, month - 1, date);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== date) return null;
  return plusDays === 0 ? start : new Date(year, month - 1, date + plusDays); // the calendar adds the days, so a DST change can't shift them
}

/** What the server is asked for. A day is from its first to the next day's first moment, in the user's time zone. */
export function boundsOf(filter: DateFilter | null): DateBoundsQuery {
  if (!filter) return {};
  const iso = (date: Date | null) => date?.toISOString();
  switch (filter.mode) {
    case "day":
      return { after: iso(localMidnight(filter.day)), before: iso(localMidnight(filter.day, 1)) };
    case "range": // both days are part of it
      return { after: iso(localMidnight(filter.from)), before: iso(localMidnight(filter.to, 1)) };
    case "since": // that day and everything newer
      return { after: iso(localMidnight(filter.day)) };
    case "before": // everything older than that day; the day itself isn't included
      return { before: iso(localMidnight(filter.day)) };
  }
}

/** Why the filter can't be applied, or null. */
export function validateFilter(filter: DateFilter): string | null {
  const days = filter.mode === "range" ? [filter.from, filter.to] : [filter.day];
  if (days.some(day => !day || localMidnight(day) === null)) return "Pick a date.";
  if (filter.mode === "range" && filter.from > filter.to) return "The range ends before it starts.";
  return null;
}

const show = (day: string) => {
  const date = localMidnight(day);
  return date ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : day;
};

/** A short description for the header chip. */
export function describeFilter(filter: DateFilter): string {
  switch (filter.mode) {
    case "day":
      return show(filter.day);
    case "range":
      return filter.from === filter.to ? show(filter.from) : `${show(filter.from)} – ${show(filter.to)}`;
    case "since":
      return `since ${show(filter.day)}`;
    case "before":
      return `before ${show(filter.day)}`;
  }
}

/** Today as `YYYY-MM-DD` in the user's time zone, for a date field's starting value. */
export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
