/**
 * Deliberately dependency-free (no imapflow, no server modules): frontend code needs this too
 * (see ComposeDialog), and importing anything from server/services/imap.ts there would pull
 * the whole imapflow package into the client bundle.
 */
export interface SpecialUseFolder {
  path: string;
  specialUse: string | null;
}

/**
 * Picks the folder matching a special-use flag (e.g. "\\Drafts", "\\Sent", "\\Trash"), falling
 * back to a literal path when none is found — e.g. the account's folder list hasn't loaded
 * yet. Needed because plenty of servers don't name these folders "Drafts"/"Sent"/"Trash" in
 * English (imapflow still recognizes many localized names too, via SPECIAL-USE/XLIST or a
 * name-based guess — see listFolders in server/services/imap.ts — but the exact path can be
 * anything).
 */
export function resolveSpecialFolder<T extends SpecialUseFolder>(folders: T[], specialUse: string, fallback: string): string {
  return folders.find(f => f.specialUse === specialUse)?.path ?? fallback;
}

/**
 * True for a folder with a recognized special role (Inbox, Sent, Trash, Junk/Spam, Drafts, Archive, ...) — the
 * ones a mail client shouldn't let you rename, since other code (or the server itself) finds them by that role
 * rather than by name.
 */
export function isSpecialFolder(folder: SpecialUseFolder): boolean {
  return folder.specialUse !== null;
}
