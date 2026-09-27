/** True when the current platform uses the Cmd key (⌘) instead of Ctrl for shortcuts. Assumed false when the browser can't tell. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent;
  return /mac/i.test(platform);
}

/** Renders a shortcut's modifier key as its platform glyph, e.g. "⌘R" on macOS, "Ctrl+R" elsewhere. */
export function modKey(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl+${key}`;
}

/** True inside the Tauri desktop app's own webview: `window.__TAURI_INTERNALS__` is the same global
 * `@tauri-apps/api`'s own `isTauri()` checks for — present whether or not the app opts into the full
 * `window.__TAURI__` JS API, which this one doesn't. */
export function isTauriApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
