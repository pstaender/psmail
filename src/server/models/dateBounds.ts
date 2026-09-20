import { ApiError } from "../types";

/**
 * A window in time for a message list: messages dated at or after `after` and before `before` (both optional, both ISO
 * instants). The bounds are compared with the stored `emails.date` as text — it is always an ISO string in UTC with
 * milliseconds (`2026-01-02T00:00:00.000Z`), which sorts like the time it stands for — so the (account, folder, date, id)
 * index serves the range directly, and the list stays ordered by it without a sort.
 */
export interface DateBounds {
  after?: string;
  before?: string;
}

/** Reads `after` / `before` from a query string, normalized to the stored format; a value that isn't a date is a 400. */
export function readDateBounds(params: URLSearchParams): DateBounds {
  const bounds: DateBounds = {};
  for (const key of ["after", "before"] as const) {
    const raw = params.get(key);
    if (raw === null || raw === "") continue;
    const time = new Date(raw).getTime();
    if (Number.isNaN(time)) throw new ApiError(400, `${key} must be a date (ISO 8601)`);
    bounds[key] = new Date(time).toISOString();
  }
  if (bounds.after && bounds.before && bounds.after >= bounds.before) throw new ApiError(400, "after must be earlier than before");
  return bounds;
}

/**
 * The SQL for the window, as plain range comparisons on `date` (no OR / IS NULL / function on the column, which would keep the
 * index from being used), and its parameters. Messages without a date are outside any window. `column` is the (qualified) name.
 */
export function dateBoundsSql(bounds: DateBounds | undefined, column = "date"): { sql: string; params: string[] } {
  let sql = "";
  const params: string[] = [];
  if (bounds?.after) {
    sql += ` AND ${column} >= ?`;
    params.push(bounds.after);
  }
  if (bounds?.before) {
    sql += ` AND ${column} < ?`;
    params.push(bounds.before);
  }
  return { sql, params };
}
