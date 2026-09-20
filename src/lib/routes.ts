import type { UnifiedKind } from "@/lib/api";

/**
 * Deep links, on plain URL paths (no hash):
 *
 *   /                              the combined Inbox
 *   /u/sent                        the combined Sent
 *   /a/<account email>/<folder>/          a folder of an account
 *   /a/<account email>/<folder>/<id>      a message in it
 *
 * `a` is short for accounts, to keep the URLs short. The folder is ONE path segment (its own slashes, as in
 * `[Gmail]/Sent Mail` or `Work/2024`, are percent-encoded) so a trailing number is always a message id, never
 * a folder called `2024`; the Inbox is written `inbox`. The `@` of the address stays readable.
 */
export interface Route {
  /** The combined mailbox being shown; null when a real folder is. */
  unified: UnifiedKind | null;
  accountEmail: string | null;
  folder: string | null;
  emailId: number | null;
}

export const HOME_ROUTE: Route = { unified: "inbox", accountEmail: null, folder: null, emailId: null };

const encodeSegment = (value: string) => encodeURIComponent(value).replace(/%40/g, "@");

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null; // a malformed escape like %E0%A4%A
  }
}

export function buildPath(route: Route): string {
  if (route.accountEmail && route.folder) {
    const folder = route.folder.toUpperCase() === "INBOX" ? "inbox" : route.folder;
    const base = `/a/${encodeSegment(route.accountEmail)}/${encodeSegment(folder)}/`;
    return route.emailId !== null ? `${base}${route.emailId}` : base;
  }
  return route.unified === "sent" ? "/u/sent" : "/";
}

/** The state a path stands for; anything unrecognized is the combined Inbox (the app's home). */
export function parsePath(pathname: string): Route {
  const parts = pathname.split("/").filter(part => part !== "");

  if (parts[0] === "u" && parts[1] === "sent" && parts.length === 2) return { ...HOME_ROUTE, unified: "sent" };

  if (parts[0] === "a" && parts.length >= 3 && parts.length <= 4) {
    const accountEmail = decodeSegment(parts[1]!);
    const rawFolder = decodeSegment(parts[2]!);
    const idPart = parts[3];
    if (accountEmail && rawFolder && (idPart === undefined || /^\d+$/.test(idPart))) {
      return {
        unified: null,
        accountEmail,
        folder: rawFolder.toUpperCase() === "INBOX" ? "INBOX" : rawFolder,
        emailId: idPart === undefined ? null : Number(idPart),
      };
    }
  }

  return HOME_ROUTE;
}
