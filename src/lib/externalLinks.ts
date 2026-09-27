import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauriApp } from "./platform";

/** Protocols a link is ever allowed to open the OS's default app for — never anything the desktop app
 * has to run itself, and never something opaque like `javascript:` (DOMPurify already strips those out
 * of message HTML, but this isn't specific to messages). */
const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * In the Tauri desktop app, clicking a link anywhere in the app — most commonly inside a message's
 * rendered HTML, which src/lib/sanitizeHtml.ts always marks target="_blank" — would otherwise do
 * nothing at all: this app's single window never handles new-window requests, so the webview just
 * drops them. This opens it in the OS's default browser/mail/phone app instead, matching what
 * target="_blank" already does in a regular browser tab. A same-origin link (there aren't any today,
 * but just in case) is left to navigate normally, since that's this app's own UI, not an external one.
 * A no-op outside the desktop app.
 *
 * `open` defaults to the real plugin call; tests hand in a fake instead, rather than mocking the
 * `@tauri-apps/plugin-opener` module (which bun:test's mock.module would replace for the whole test
 * run, not just one file — see the comment on this in tests/unit/sync.test.ts).
 */
export function installExternalLinkHandler(open: (url: string) => Promise<void> = openUrl): () => void {
  if (!isTauriApp()) return () => {};

  function onClick(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link) return;

    let url: URL;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return;
    }
    if (!OPENABLE_PROTOCOLS.has(url.protocol)) return;
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === window.location.origin) return;

    event.preventDefault();
    void open(link.href);
  }

  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
