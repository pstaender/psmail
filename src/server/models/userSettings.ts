import { Database } from "bun:sqlite";
import { ApiError, NotFoundError } from "../types";

export const BODY_VIEWS = ["text", "md", "plain", "safe", "full"] as const;

/** Per-user preferences persisted server-side (users.settings, JSON). Every key is optional. */
export interface UserSettings {
  /** The reading-pane tab last used (Text / MD / Plain text / Safe HTML / Full HTML). */
  bodyView?: (typeof BODY_VIEWS)[number];
}

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
    } else {
      throw new ApiError(400, `Unknown setting "${key}"`);
    }
  }

  db.query("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(next), userId);
  return next as UserSettings;
}
