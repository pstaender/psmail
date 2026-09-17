import { describe, expect, test } from "bun:test";
import { buildClearestText, markdownFromHtml } from "../../src/lib/textView";

describe("buildClearestText", () => {
  test("prefers plain text when available, stripping any stray HTML tags", () => {
    const result = buildClearestText({ plainText: "Hello <b>world</b> &amp; friends", htmlText: "<p>ignored</p>" });
    expect(result).toBe("Hello world & friends");
  });

  test("falls back to HTML converted to Markdown when there's no plain text", () => {
    const result = buildClearestText({
      plainText: null,
      htmlText: "<p>Hello <strong>world</strong></p><p><a href='https://example.com/x?utm_source=y'>Read more</a></p>",
    });
    expect(result).toContain("Hello **world**");
    expect(result).toContain("[Read more](https://example.com/x)");
  });

  test("returns null when the message has neither part", () => {
    expect(buildClearestText({ plainText: null, htmlText: null })).toBeNull();
    expect(buildClearestText({ plainText: "  ", htmlText: "" })).toBeNull();
  });
});

describe("markdownFromHtml", () => {
  test("drops boilerplate footer links but keeps real content links", () => {
    // A bare boilerplate link (no surrounding footer wrapper Defuddle would drop outright)
    // should be de-linked by the Turndown rule itself: its text stays, its href doesn't.
    const html = `<p>Check out our <a href="https://example.com/sale?utm_campaign=x">summer sale</a>.</p>
      <p>Manage your subscription: <a href="https://example.com/unsub">Unsubscribe</a></p>`;
    const result = markdownFromHtml(html);
    expect(result).toContain("[summer sale](https://example.com/sale)");
    expect(result).not.toContain("[Unsubscribe]");
    expect(result).not.toContain("example.com/unsub");
    expect(result).toContain("Unsubscribe");
  });

  test("drops images entirely", () => {
    const result = markdownFromHtml("<p>Hello</p><img src='https://example.com/banner.png' alt='banner'>");
    expect(result).not.toContain("![");
    expect(result).not.toContain("banner.png");
  });

  test("strips invisible Unicode padding characters used for preheader text", () => {
    const html = `<p>Hello${"​ ͏"} world</p>`;
    const result = markdownFromHtml(html);
    expect(result).toBe("Hello world");
  });

  test("drops links with empty/icon-only text", () => {
    const html = `<p>Follow us: <a href="https://example.com/fb"><img src="https://example.com/icon.png"></a></p>`;
    const result = markdownFromHtml(html);
    expect(result).not.toContain("[](");
    expect(result).not.toContain("example.com/fb");
  });
});
