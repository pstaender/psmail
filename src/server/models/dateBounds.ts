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

/**
 * What narrows a message list: a date window and/or categories (the AI's taxonomy labels). A message must have EVERY
 * chosen category.
 */
export interface ListFilter extends DateBounds {
  categories?: string[];
}

export const MAX_FILTER_CATEGORIES = 20;
const MAX_CATEGORY_LENGTH = 100;

/** `after` / `before` and any number of `category` parameters; a bad date is a 400, as is a category that is far too long or too many. */
export function readListFilter(params: URLSearchParams): ListFilter {
  const filter: ListFilter = readDateBounds(params);
  const categories = [...new Set(params.getAll("category").map(label => label.trim()).filter(label => label !== ""))];
  if (categories.length > MAX_FILTER_CATEGORIES) throw new ApiError(400, `At most ${MAX_FILTER_CATEGORIES} categories can be combined`);
  if (categories.some(label => label.length > MAX_CATEGORY_LENGTH)) throw new ApiError(400, "A category is too long");
  if (categories.length > 0) filter.categories = categories;
  return filter;
}

/**
 * The SQL for a whole filter: the date range (see dateBoundsSql) and one condition per category, each an EXISTS over the
 * message's own label list (a small JSON array in `taxonomy_list`). The conditions only look at the row being considered, so
 * the list is still walked in the date index's order and stops as soon as the page is full; a message with no labels, or
 * with a list that isn't valid JSON, simply doesn't match. `columns` name the (qualified) date and taxonomy columns.
 */
export function listFilterSql(
  filter: ListFilter | undefined,
  columns: { date?: string; taxonomy?: string } = {}
): { sql: string; params: string[] } {
  const dates = dateBoundsSql(filter, columns.date ?? "date");
  const taxonomy = columns.taxonomy ?? "taxonomy_list";
  let sql = dates.sql;
  const params = [...dates.params];
  for (const label of filter?.categories ?? []) {
    sql += ` AND CASE WHEN json_valid(${taxonomy}) THEN EXISTS (SELECT 1 FROM json_each(${taxonomy}) WHERE value = ?) ELSE 0 END`;
    params.push(label);
  }
  return { sql, params };
}
