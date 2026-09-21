import DOMPurify from "dompurify";
import { stripTrackingParams } from "./trackingParams";

const BASE_FORBID_TAGS = ["script", "iframe", "object", "embed", "form", "base", "link", "meta"];

function rewriteLinks(root: Element) {
  root.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href");
    if (!href) return;
    a.setAttribute("href", stripTrackingParams(href));
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer nofollow");
  });
}

/** `url(...)` of any spelling — bare, 'single' or "double" quoted (a quoted value may itself contain parentheses). */
const CSS_URL = /url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi;
const REMOTE_URL_IN_CSS = /url\(\s*['"]?\s*https?:\/\/[^)'"]*['"]?\s*\)/gi;
/** `@import` pulls in a whole remote stylesheet, by `url(...)` or by a plain string. */
const CSS_IMPORT = /@import[^;{}]*;?/gi;

/** Strips only remote `url(http...)` references from an inline style (background images etc.), leaving other rules intact. */
function stripRemoteCssUrls(style: string): string {
  return style.replace(CSS_IMPORT, "").replace(REMOTE_URL_IN_CSS, "none");
}

/** Strips `url(data:...)` (inline images used as backgrounds, SVG included) from a style, leaving the other rules. */
function stripInlineCssUrls(style: string): string {
  return style.replace(CSS_URL, match => (/^url\(\s*['"]?\s*(data|cid|blob):/i.test(match) ? "none" : match));
}

const INLINE_SRC = /^\s*(data|cid|blob):/i;

/**
 * Safe HTML shows text, not pictures that are part of the mail itself: removes inline images (`data:` and `blob:` sources,
 * `cid:` references to an attachment), every embedded SVG (an <svg> element, which can carry a whole drawing — or markup
 * of its own), and inline `url(data:...)` backgrounds. Remote images are dealt with separately (blockExternalResources).
 */
function removeInlineImages(root: Element) {
  root.querySelectorAll("svg, math").forEach(el => el.remove());

  root.querySelectorAll("img, image, input[type=image], video[poster]").forEach(el => {
    const src = el.getAttribute("src") ?? el.getAttribute("href") ?? el.getAttribute("poster") ?? "";
    const isImg = el.tagName.toLowerCase() === "img";
    // An <img> without any source left had one the sanitizer already refused (an odd spelling of data:, say): nothing to show.
    if (isImg && !el.hasAttribute("src") && !el.hasAttribute("srcset")) el.remove();
    else if (isImg && (INLINE_SRC.test(src) || /^\s*data:/i.test(el.getAttribute("srcset") ?? ""))) el.remove();
    else if (INLINE_SRC.test(src)) el.remove();
  });
  root.querySelectorAll("source[srcset], source[src]").forEach(el => {
    if (INLINE_SRC.test(el.getAttribute("src") ?? "") || INLINE_SRC.test(el.getAttribute("srcset") ?? "")) el.remove();
  });
  root.querySelectorAll("[background]").forEach(el => {
    if (INLINE_SRC.test(el.getAttribute("background") ?? "")) el.removeAttribute("background");
  });

  root.querySelectorAll<HTMLElement>("[style]").forEach(el => {
    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", stripInlineCssUrls(style));
  });
  root.querySelectorAll("style").forEach(styleTag => {
    styleTag.textContent = stripInlineCssUrls(styleTag.textContent ?? "");
  });
}

function blockExternalResources(root: Element) {
  root.querySelectorAll("img[src], source[src], source[srcset]").forEach(el => {
    const src = el.getAttribute("src") ?? "";
    const srcset = el.getAttribute("srcset") ?? "";
    if (/^https?:\/\//i.test(src) || /^https?:\/\//i.test(srcset)) {
      el.removeAttribute("src");
      el.removeAttribute("srcset");
      el.setAttribute("data-psmail-blocked", "true");
    }
  });

  root.querySelectorAll<HTMLElement>("[style]").forEach(el => {
    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", stripRemoteCssUrls(style));
  });

  root.querySelectorAll("style").forEach(styleTag => {
    styleTag.textContent = stripRemoteCssUrls(styleTag.textContent ?? "");
  });
}

export interface SanitizeOptions {
  /** When false (default), remote images/backgrounds are stripped and a placeholder marker is left instead. */
  allowExternalContent?: boolean;
  /** The DOMPurify to use. Only for tests: the app's own DOM (happy-dom) can't run DOMPurify, a real one (jsdom) can. */
  purifier?: Pick<typeof DOMPurify, "sanitize">;
  /** Safe HTML: also remove inline images (data:/cid:), embedded SVG and inline CSS images — see removeInlineImages. */
  stripInlineImages?: boolean;
  /** When false (default), known tracking query params are stripped from http(s) link hrefs. Safe-HTML always does this; Full-HTML leaves links untouched to show the email "as-is". */
  stripLinkTracking?: boolean;
}

/**
 * Sanitizes email HTML for display. Always strips scripts, event handlers,
 * and dangerous embeds (DOMPurify defaults + an explicit forbid list) since
 * no legitimate email needs to run script in the reader — that applies to
 * both the "safe" and "full" view. What differs between the two is whether
 * external images/backgrounds are blocked and whether link tracking params
 * are stripped.
 */
export function sanitizeEmailHtml(html: string, options: SanitizeOptions = {}): string {
  const container = document.createElement("div");

  // Wrapped in an extra <div>: DOMPurify (at least under happy-dom, our test DOM) drops the
  // single outermost node of whatever fragment it's given — e.g. sanitizing "<h2>x</h2>" alone
  // returns just "x" — but preserves the same content correctly once it isn't the outermost
  // node. The wrapper itself is unwrapped away in the output, so this only affects what survives.
  const clean = (options.purifier ?? DOMPurify).sanitize(`<div>${html}</div>`, {
    FORBID_TAGS: BASE_FORBID_TAGS,
    FORBID_ATTR: ["srcdoc"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_DOM_FRAGMENT: false,
  });

  container.innerHTML = clean;

  if (options.stripInlineImages) removeInlineImages(container);
  if (!options.allowExternalContent) blockExternalResources(container);
  if (options.stripLinkTracking !== false) rewriteLinks(container);

  return container.innerHTML;
}
