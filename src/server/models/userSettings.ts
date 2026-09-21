import { Database } from "bun:sqlite";
import { ApiError, NotFoundError } from "../types";

/** The bundled new-mail sounds (see src/sounds and src/lib/notifications.ts), plus "none". */
export const NOTIFICATION_SOUNDS = ["crystal_clear", "cute_bell", "marimba", "none"] as const;

export const BODY_VIEWS = ["text", "md", "plain", "safe", "full"] as const;

/** Per-user preferences persisted server-side (users.settings, JSON). Every key is optional. */
export interface UserSettings {
  /** The reading-pane tab last used (Text / MD / Plain / Safe HTML / HTML). */
  bodyView?: (typeof BODY_VIEWS)[number];
  /** How often (minutes) the web client triggers a sync of all accounts while it's open. Unset = never. */
  syncIntervalMinutes?: number;
  /** Opt-in: the combined Inbox also lists mail from an account's other folders (not Sent/Drafts/Trash/Junk/Archive). */
  combinedInboxIncludesFolders?: boolean;
  /** Opt-in: a browser (desktop) notification when new mail arrives. */
  notifyBrowser?: boolean;
  /** Opt-in: an in-app toast with sender, subject, a text preview and details when new mail arrives. */
  notifyToast?: boolean;
  /** Sound played with the toast; unset means crystal_clear. */
  notificationSound?: (typeof NOTIFICATION_SOUNDS)[number];
  /** Opt-in: the imbox — the important part of the combined Inbox, picked by the local classifier — is shown between the combined Inbox and Sent. */
  imboxEnabled?: boolean;
  /** The language the translate skill translates into (e.g. "German"); unset means English. */
  aiTargetLanguage?: string;
}

export const MAX_SYNC_INTERVAL_MINUTES = 24 * 60;

export function getUserSettings(db: Database, userId: number): UserSettings {
  const row = db.query<{ settings: string }, [number]>("SELECT settings FROM users WHERE id = ?").get(userId);
  if (!row) throw new NotFoundError(`User ${userId} not found`);
  try {
    const parsed = JSON.parse(row.settings);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Shallow-merges `patch` into the stored settings; a key set to null is removed. Unknown keys and invalid values are rejected. */
export function updateUserSettings(db: Database, userId: number, patch: Record<string, unknown>): UserSettings {
  const next: Record<string, unknown> = { ...getUserSettings(db, userId) };

  for (const [key, value] of Object.entries(patch)) {
    if (key === "bodyView") {
      if (value === null) delete next.bodyView;
      else if (typeof value === "string" && (BODY_VIEWS as readonly string[]).includes(value)) next.bodyView = value;
      else throw new ApiError(400, `bodyView must be one of: ${BODY_VIEWS.join(", ")}`);
    } else if (key === "syncIntervalMinutes") {
      if (value === null) delete next.syncIntervalMinutes;
      else if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SYNC_INTERVAL_MINUTES) next.syncIntervalMinutes = value;
      else throw new ApiError(400, `syncIntervalMinutes must be a whole number of minutes between 1 and ${MAX_SYNC_INTERVAL_MINUTES}, or null for never`);
    } else if (key === "combinedInboxIncludesFolders") {
      if (value === null) delete next.combinedInboxIncludesFolders;
      else if (typeof value === "boolean") next.combinedInboxIncludesFolders = value;
      else throw new ApiError(400, "combinedInboxIncludesFolders must be true or false");
    } else if (key === "imboxEnabled") {
      if (value === null) delete next.imboxEnabled;
      else if (typeof value === "boolean") next.imboxEnabled = value;
      else throw new ApiError(400, "imboxEnabled must be true or false");
    } else if (key === "notifyBrowser" || key === "notifyToast") {
      if (value === null) delete next[key];
      else if (typeof value === "boolean") next[key] = value;
      else throw new ApiError(400, `${key} must be true or false`);
    } else if (key === "aiTargetLanguage") {
      if (value === null) delete next.aiTargetLanguage;
      else if (typeof value === "string" && value.trim() && value.trim().length <= 60) next.aiTargetLanguage = value.trim();
      else throw new ApiError(400, "aiTargetLanguage must be a language name of up to 60 characters");
    } else if (key === "notificationSound") {
      if (value === null) delete next.notificationSound;
      else if (typeof value === "string" && (NOTIFICATION_SOUNDS as readonly string[]).includes(value)) next.notificationSound = value;
      else throw new ApiError(400, `notificationSound must be one of: ${NOTIFICATION_SOUNDS.join(", ")}`);
    } else {
      throw new ApiError(400, `Unknown setting "${key}"`);
    }
  }

  db.query("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(next), userId);
  return next as UserSettings;
}
