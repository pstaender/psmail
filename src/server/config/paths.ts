import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root config directory for P.S.Mail, resolved per-platform:
 * - macOS:   ~/Library/Application Support/psmail
 * - Windows: %APPDATA%\psmail
 * - Linux/other: $XDG_CONFIG_HOME/psmail or ~/.config/psmail
 */
export function getConfigDir(): string {
  if (process.env.PSMAIL_CONFIG_DIR) return process.env.PSMAIL_CONFIG_DIR;

  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "psmail");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "psmail");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "psmail");
  }
}

export function getSettingsPath(): string {
  return join(getConfigDir(), "settings.json");
}

export function getDatabasePath(): string {
  return join(getConfigDir(), "psmail.sqlite");
}

export function getAttachmentsDir(): string {
  return join(getConfigDir(), "attachments");
}

/** Directory holding attachment files for one account, namespaced by user and account. */
export function getAccountAttachmentsDir(username: string, accountEmail: string): string {
  return join(getAttachmentsDir(), sanitizeSegment(username), sanitizeSegment(accountEmail));
}

export function getEmailAttachmentsDir(username: string, accountEmail: string, emailId: number | string): string {
  return join(getAccountAttachmentsDir(username, accountEmail), String(emailId));
}

/** Prevent path traversal / invalid filesystem segments from user-controlled strings. */
export function sanitizeSegment(segment: string): string {
  return segment.replace(/[/\\?%*:|"<>]/g, "_");
}
