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
