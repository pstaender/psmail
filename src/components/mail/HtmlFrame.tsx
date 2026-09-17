import { useEffect, useRef, useState } from "react";

const FRAME_BASE_STYLES = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #1a1a1a;
    background: #ffffff;
    padding: 12px 16px;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  img, table { max-width: 100%; }
  a { color: #2563eb; }
`;

/**
 * Renders already-sanitized email HTML in a sandboxed iframe, isolated from
 * the app's own DOM/CSS. No `allow-scripts`, so embedded JS never executes
 * regardless of what slipped through sanitization — this is a defense-in-depth
 * layer, not the only one. `allow-popups(-to-escape-sandbox)` lets links open
 * in a normal new tab; `allow-same-origin` lets the parent read the iframe's
 * scrollHeight to auto-size it (there's no script running inside to do that
 * itself).
 */
export function HtmlFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    const resize = () => {
      const doc = iframe.contentDocument;
      if (doc?.documentElement) {
        setHeight(Math.min(doc.documentElement.scrollHeight + 4, window.innerHeight));
      }
    };

    let observer: ResizeObserver | null = null;

    const onLoad = () => {
      resize();
      const body = iframe.contentDocument?.body;
      if (body && "ResizeObserver" in window) {
        observer = new ResizeObserver(resize);
        observer.observe(body);
      }
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [html]);

  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_BASE_STYLES}</style></head><body>${html}</body></html>`;

  return (
    <iframe
      ref={ref}
      title="Email content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      style={{ height, width: "100%", border: "none", display: "block" }}
    />
  );
}
