/** True when the current platform uses the Cmd key (⌘) instead of Ctrl for shortcuts. Assumed false when the browser can't tell. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent;
  return /mac/i.test(platform);
}

/** True when running inside the Electron desktop app (see electronapp/), not a regular browser. Electron's Chromium adds "Electron/x.y.z" to the default user agent. */
export function isElectron(): boolean {
  if (typeof navigator === "undefined") return false;
  return /\belectron\//i.test(navigator.userAgent);
}

/** Renders a shortcut's modifier key as its platform glyph, e.g. "⌘R" on macOS, "Ctrl+R" elsewhere. */
export function modKey(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl+${key}`;
}
