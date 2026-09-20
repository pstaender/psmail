/**
 * Reading the JSON arrays AI models answer with (categories, events). Models sometimes write typographic quotes —
 * “veranstaltung” or „musik“ instead of "veranstaltung" — which is not JSON, so a plain JSON.parse fails on an answer that is
 * otherwise perfectly fine.
 */

const DOUBLE_QUOTES = /[“”„‟″〝〞＂«»❝❞]/g;
const SINGLE_QUOTES = /[‘’‚‛❛❜]/g;

/**
 * The JSON array in an answer (found inside other text or a code fence too), as an array — or null when there isn't a usable
 * one. The text is tried as written first, so valid JSON is never touched (a typographic quote inside a proper string stays);
 * only when that fails are the typographic double quotes turned into plain ones, then the typographic and finally the plain
 * single quotes as well (['a', 'b'] is a Python-ism models are prone to).
 */
export function parseJsonArray(answer: string): unknown[] | null {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  const text = answer.slice(start, end + 1);

  const doubled = text.replace(DOUBLE_QUOTES, '"');
  const candidates = [text, doubled, doubled.replace(SINGLE_QUOTES, '"'), doubled.replace(SINGLE_QUOTES, '"').replace(/'/g, '"')];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try the next, more forgiving reading
    }
  }
  return null;
}

/** Quote characters of any kind, for trimming them off the ends of a label that was split out loosely. */
export const ANY_QUOTES_AT_ENDS = /^["'`“”„‟″‘’‚‛«»❝❞❛❜]+|["'`“”„‟″‘’‚‛«»❝❞❛❜]+$/g;
