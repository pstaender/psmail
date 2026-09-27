import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installExternalLinkHandler } from "../../src/lib/externalLinks";

function clickLink(href: string, target?: string): void {
  const a = document.createElement("a");
  a.href = href;
  if (target) a.target = target;
  a.textContent = "link";
  document.body.appendChild(a);
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  a.remove();
}

describe("installExternalLinkHandler", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("outside the Tauri app: does nothing, and the returned cleanup is a harmless no-op", () => {
    const opened: string[] = [];
    uninstall = installExternalLinkHandler(async url => void opened.push(url));
    clickLink("https://example.com/", "_blank");
    expect(opened).toEqual([]);
    expect(() => uninstall!()).not.toThrow();
  });

  describe("inside the Tauri app", () => {
    beforeEach(() => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    });

    test("opens an external http(s) link in the system browser instead of navigating the app", () => {
      const opened: string[] = [];
      uninstall = installExternalLinkHandler(async url => void opened.push(url));
      clickLink("https://example.com/newsletter", "_blank");
      expect(opened).toEqual(["https://example.com/newsletter"]);
    });

    test("opens mailto: and tel: links the same way", () => {
      const opened: string[] = [];
      uninstall = installExternalLinkHandler(async url => void opened.push(url));
      clickLink("mailto:someone@example.com");
      clickLink("tel:+1234567890");
      expect(opened).toEqual(["mailto:someone@example.com", "tel:+1234567890"]);
    });

    test("leaves a same-origin link (this app's own UI) to navigate normally", () => {
      const opened: string[] = [];
      uninstall = installExternalLinkHandler(async url => void opened.push(url));
      clickLink(window.location.origin + "/a/me@example.com/inbox/");
      expect(opened).toEqual([]);
    });

    test("ignores a modified click (Cmd/Ctrl/Shift/middle-click — the browser's own 'open in new tab' etc.)", () => {
      const opened: string[] = [];
      uninstall = installExternalLinkHandler(async url => void opened.push(url));
      const a = document.createElement("a");
      a.href = "https://example.com/";
      document.body.appendChild(a);
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
      a.remove();
      expect(opened).toEqual([]);
    });

    test("a click with no anchor ancestor is ignored", () => {
      const opened: string[] = [];
      uninstall = installExternalLinkHandler(async url => void opened.push(url));
      const div = document.createElement("div");
      document.body.appendChild(div);
      div.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      div.remove();
      expect(opened).toEqual([]);
    });

    test("uninstalling removes the listener", () => {
      const opened: string[] = [];
      uninstall = installExternalLinkHandler(async url => void opened.push(url));
      uninstall();
      uninstall = null;
      clickLink("https://example.com/");
      expect(opened).toEqual([]);
    });
  });
});
