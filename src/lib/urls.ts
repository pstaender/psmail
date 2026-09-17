/** Drops every query parameter from an http(s) URL. Other schemes (mailto:, tel:, ...) are returned unchanged, since their "query" syntax isn't tracking. Unparseable input is returned as-is. */
export function stripAllQueryParams(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return href;
  url.search = "";
  return url.toString();
}
