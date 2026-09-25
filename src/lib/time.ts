/**
 * A message list's compact date column: today shows the time, yesterday says "Yesterday", the 5 days before that
 * show the weekday name ("Monday", …) — all of them easier to place at a glance than a bare date — and anything
 * older falls back to a short date (with the year too, once it's not this year). `forceDate` (Settings → UI →
 * "Display dates instead of time expressions") skips straight to that fallback, always, for anyone who'd rather
 * see the actual date than work out what "Yesterday" or "Monday" means right now.
 */
export function formatListDate(iso: string | null, opts: { forceDate?: boolean } = {}): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();

  if (!opts.forceDate) {
    for (let daysAgo = 0; daysAgo <= 6; daysAgo++) {
      const reference = new Date(now);
      reference.setDate(now.getDate() - daysAgo);
      if (date.toDateString() !== reference.toDateString()) continue;
      if (daysAgo === 0) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      if (daysAgo === 1) return "Yesterday";
      return date.toLocaleDateString(undefined, { weekday: "long" });
    }
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function formatFullDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}
