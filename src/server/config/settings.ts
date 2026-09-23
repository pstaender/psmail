import { getConfigDir, getSettingsPath } from "./paths";

export interface Settings {
  /** HTTP port the API server listens on. */
  port: number;
  /**
   * Interface the API server binds to; passed straight to Bun.serve. Optional: a freshly created settings.json gets
   * "127.0.0.1" written in (local traffic only), but the field itself stays optional so an existing settings.json
   * without it keeps working exactly as before (Bun's own default, every interface) rather than suddenly locking
   * out whatever was reaching it. Set it to "0.0.0.0" (or leave it unset) to open the server up again.
   */
  hostname?: string;
  /** Session lifetime in seconds. */
  sessionTtlSeconds: number;
  /** Log every AI API call (what is sent, what comes back, how long it took, the tokens) to the server's console. Off by default. */
  verboseAiApiCalls?: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  port: 3001,
  sessionTtlSeconds: 60 * 60 * 12,
};

let cached: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;

  const path = getSettingsPath();
  const file = Bun.file(path);

  if (await file.exists()) {
    const parsed = (await file.json()) as Partial<Settings>;
    cached = { ...DEFAULT_SETTINGS, ...parsed };
  } else {
    // A brand-new install: default to local traffic only. Written explicitly (not into DEFAULT_SETTINGS itself), so
    // an existing settings.json from before this setting existed is never retroactively restricted.
    cached = { ...DEFAULT_SETTINGS, hostname: "127.0.0.1" };
    await saveSettings(cached);
  }

  return cached;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await Bun.$`mkdir -p ${getConfigDir()}`.quiet();
  await Bun.write(getSettingsPath(), JSON.stringify(settings, null, 2));
  cached = settings;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await saveSettings(next);
  return next;
}

/** The settings as already loaded (the server loads them at start), or null — for code that must not touch the disk. */
export function peekSettings(): Settings | null {
  return cached;
}

/** For tests: force settings to be reloaded from disk on next access. */
export function resetSettingsCache(): void {
  cached = null;
}
