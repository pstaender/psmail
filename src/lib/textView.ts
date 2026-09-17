import Defuddle from "defuddle";
import TurndownService from "turndown";
import { stripAllQueryParams } from "./urls";

/** Strips any stray HTML tags from a value that's supposed to already be plain text, decoding entities along the way. */
function stripHtmlTags(text: string): string {
  const div = document.createElement("div");
  div.innerHTML = text;
  return div.textContent ?? text;
}

// Unicode "Format" category (Cf) covers zero-width space/joiners, BOM, word
// joiner, soft hyphen, directional marks, etc. — exactly the invisible
// characters marketing email templates pad preheader text with. They're not
// hidden via CSS (so element-removal doesn't catch them), just invisible
// characters sitting in otherwise-visible text nodes. U+034F (COMBINING
// GRAPHEME JOINER) is added explicitly: it's category Mn, not Cf, but is
// always zero-width by definition regardless of context, and shows up in
// the same padding role, alternated with visible space variants.
const INVISIBLE_CHARS = /[\p{Cf}͏]/gu;

/** Drops invisible padding characters and collapses the run of (often non-ASCII) spaces they typically leave behind. */
function cleanupWhitespace(text: string): string {
  return text
    .replace(INVISIBLE_CHARS, "")
    .replace(/[\t\p{Zs}]{2,}/gu, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Footer/boilerplate link text that adds no reading value to a "clearest possible text" view. */
const BOILERPLATE_LINK_PHRASES = [
  "unsubscribe",
  "view in browser",
  "view this email",
  "view online",
  "view this in your browser",
  "privacy policy",
  "terms of service",
  "terms of use",
  "terms & conditions",
  "terms and conditions",
  "cookie policy",
  "manage subscription",
  "update subscription",
  "manage preferences",
  "manage your preferences",
  "update your preferences",
  "update preferences",
  "email preferences",
  "opt out",
  "opt-out",
];

function isIrrelevantLinkText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true; // empty/icon-only link
  return BOILERPLATE_LINK_PHRASES.some(phrase => normalized.includes(phrase));
}

function createTurndownService(): TurndownService {
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });

  // A text view has no room for banner/tracking-pixel image noise.
  turndown.addRule("dropImages", {
    filter: "img",
    replacement: () => "",
  });

  // Keep only links with real, non-boilerplate text, with tracking query params stripped from what stays.
  turndown.addRule("relevantLinksOnly", {
    filter: "a",
    replacement: (content, node) => {
      const text = content.trim();
      const href = (node as HTMLAnchorElement).getAttribute("href");
      if (!href || isIrrelevantLinkText(text)) return text;

      const cleaned = stripAllQueryParams(href);
      if (!/^https?:\/\//i.test(cleaned)) return text;

      return `[${text}](${cleaned})`;
    },
  });

  return turndown;
}

/**
 * Converts email HTML to Markdown for the "Text" view: runs Defuddle first
 * to drop layout/boilerplate clutter (marketing emails are almost all
 * nested-table layout, which is exactly what Defuddle's table-content path
 * targets), then Turndown with the link/image rules above. Defuddle is
 * given a detached, parsed document — never the live page — and network
 * fetching extractors are disabled, since this runs on untrusted email
 * content and must never make outbound requests on its own.
 */
export function markdownFromHtml(html: string): string {
  let contentHtml = html;

  try {
    const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
    const result = new Defuddle(doc, { removeImages: true, useAsync: false }).parse();
    if (result.content && result.content.trim()) contentHtml = result.content;
  } catch {
    // Defuddle is best-effort cleanup; fall back to converting the raw HTML on any failure.
  }

  return cleanupWhitespace(createTurndownService().turndown(contentHtml));
}

/**
 * Builds the "Text" view body: the plain-text part if the message has one
 * (defensively stripped of any stray HTML tags), otherwise the HTML part
 * cleaned up and converted to Markdown. Returns null if the message has
 * neither.
 */
export function buildClearestText(email: { plainText: string | null; htmlText: string | null }): string | null {
  if (email.plainText && email.plainText.trim()) {
    return cleanupWhitespace(stripHtmlTags(email.plainText));
  }
  if (email.htmlText && email.htmlText.trim()) {
    return markdownFromHtml(email.htmlText);
  }
  return null;
}
