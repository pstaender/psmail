import DOMPurify from "dompurify";
import { stripAllQueryParams } from "./urls";

const BASE_FORBID_TAGS = ["script", "iframe", "object", "embed", "form", "base", "link", "meta"];

function rewriteLinks(root: Element) {
  root.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href");
    if (!href) return;
    a.setAttribute("href", stripAllQueryParams(href));
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer nofollow");
  });
}

const REMOTE_URL_IN_CSS = /url\(\s*['"]?\s*https?:\/\/[^)'"]*['"]?\s*\)/gi;

/** Strips only remote `url(http...)` references from an inline style (background images etc.), leaving other rules intact. */
function stripRemoteCssUrls(style: string): string {
  return style.replace(REMOTE_URL_IN_CSS, "none");
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
  /** When false (default), all query params are stripped from http(s) link hrefs. Safe-HTML always does this; Full-HTML leaves links untouched to show the email "as-is". */
  stripLinkTracking?: boolean;
}

/**
 * Sanitizes email HTML for display. Always strips scripts, event handlers,
 * and dangerous embeds (DOMPurify defaults + an explicit forbid list) since
 * no legitimate email needs to run script in the reader — that applies to
 * both the "safe" and "full" view. What differs between the two is whether
 * external images/backgrounds are blocked and whether link query params
 * are stripped.
 */
export function sanitizeEmailHtml(html: string, options: SanitizeOptions = {}): string {
  const container = document.createElement("div");

  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: BASE_FORBID_TAGS,
    FORBID_ATTR: ["srcdoc"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_DOM_FRAGMENT: false,
  });

  container.innerHTML = clean;

  if (!options.allowExternalContent) blockExternalResources(container);
  if (options.stripLinkTracking !== false) rewriteLinks(container);

  return container.innerHTML;
}
