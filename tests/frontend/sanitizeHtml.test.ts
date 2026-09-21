import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { sanitizeEmailHtml as sanitize, type SanitizeOptions } from "../../src/lib/sanitizeHtml";

// The test DOM (happy-dom) can't run DOMPurify — it returns its input untouched — so these tests hand the sanitizer a DOMPurify
// running on a real DOM (jsdom), which is what a browser gives the app.
const purifier = createDOMPurify(new JSDOM("").window as unknown as Window & typeof globalThis);
const sanitizeEmailHtml = (html: string, options: SanitizeOptions = {}) => sanitize(html, { ...options, purifier });

const safe = (html: string) => sanitizeEmailHtml(html, { allowExternalContent: false, stripLinkTracking: true, stripInlineImages: true });
const full = (html: string) => sanitizeEmailHtml(html, { allowExternalContent: true, stripLinkTracking: false });
const both: [string, (html: string) => string][] = [["Safe HTML", safe], ["HTML", full]];

/** What must never survive in either view: anything that could run script. */
function expectNoScript(out: string) {
  const dom = document.createElement("div");
  dom.innerHTML = out;
  expect(dom.querySelector("script")).toBeNull();
  for (const el of Array.from(dom.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.toLowerCase().startsWith("on")).toBe(false); // no event handlers
      if (["href", "src", "action", "formaction", "xlink:href", "data", "poster", "background"].includes(attr.name.toLowerCase())) {
        expect(attr.value.trim().toLowerCase().replace(/[\s\u0000-\u001f]/g, "")).not.toMatch(/^(javascript|vbscript|data:text\/html)/);
      }
    }
  }
  expect(dom.querySelector("iframe, object, embed, applet, base, meta, link, form, frame, frameset")).toBeNull();
  expect(out.toLowerCase()).not.toContain("javascript:");
}

describe.each(both)("%s: no script, ever", (_name, clean) => {
  test("script elements — plain, with attributes, in different spellings, and inside SVG — are gone with their code", () => {
    for (const html of [
      "<p>hi</p><script>alert(1)</script>",
      '<script src="https://evil.example/x.js"></script><p>hi</p>',
      "<SCRIPT>alert(1)</SCRIPT><p>hi</p>",
      "<p>hi</p><svg><script>alert(1)</script></svg>",
      '<svg xmlns="http://www.w3.org/2000/svg"><script href="data:text/javascript,alert(1)"/></svg><p>hi</p>',
      "<p>hi</p><noscript><script>alert(1)</script></noscript>",
    ]) {
      const out = clean(html);
      expectNoScript(out);
      expect(out).not.toContain("alert(1)");
      expect(out).toContain("hi");
    }
  });

  test("a split-up <script> tag leaves nothing but inert text", () => {
    const out = clean("<scr<script>ipt>alert(1)</scr</script>ipt><p>hi</p>");
    expectNoScript(out);
    expect(out).toContain("<p>hi</p>");
    expect(out).not.toMatch(/<script/i); // what is left of it is escaped text ("ipt&gt;alert(1)…"), not markup
  });

  test("event handler attributes are removed from every element, SVG and MathML included", () => {
    for (const html of [
      '<img src="x.png" onerror="alert(1)">',
      '<p onclick="alert(1)" onmouseover=alert(1)>hi</p>',
      '<body onload="alert(1)"><p>hi</p></body>',
      '<svg onload="alert(1)"><circle onclick="alert(1)" r="5"/></svg>',
      '<math><mi onmouseover="alert(1)">x</mi></math>',
      '<details open ontoggle="alert(1)"><summary>s</summary></details>',
      '<input autofocus onfocus="alert(1)">',
      '<a href="https://example.com" onclick="alert(1)">link</a>',
    ]) {
      const out = clean(html);
      expectNoScript(out);
      expect(out).not.toContain("alert(1)");
    }
  });

  test("javascript: and other script URLs are removed from links, images, forms and SVG references", () => {
    for (const html of [
      '<a href="javascript:alert(1)">x</a>',
      '<a href=" JaVaScRiPt:alert(1)">x</a>',
      '<a href="java\tscript:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="vbscript:msgbox(1)">x</a>',
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      '<img src="javascript:alert(1)">',
      '<area href="javascript:alert(1)" shape="rect" coords="0,0,9,9">',
      '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
      '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
      '<form action="javascript:alert(1)"><button>x</button></form>',
      '<button formaction="javascript:alert(1)">x</button>',
      '<video poster="javascript:alert(1)"></video>',
    ]) {
      const out = clean(html);
      expectNoScript(out);
      expect(out).not.toContain("alert(1)");
    }
  });

  test("embeds that could load or run something are removed: iframe (also srcdoc), object, embed, base, meta refresh, link, form", () => {
    for (const html of [
      '<iframe src="https://evil.example"></iframe>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<object data="https://evil.example/x.swf"></object>',
      '<embed src="https://evil.example/x.swf">',
      '<base href="https://evil.example/">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<form action="https://evil.example"><input name="pw"></form>',
    ]) {
      expectNoScript(clean(html));
    }
  });

  test("legitimate mail survives: text, links (opened safely), tables, lists and styles", () => {
    const out = clean('<h2>Title</h2><p style="color:red">Hello <b>bold</b> <a href="https://example.com/a">link</a></p><table><tr><td>cell</td></tr></table><ul><li>one</li></ul>');
    expect(out).toContain("<h2>");
    expect(out).toContain("Hello");
    expect(out).toContain("<b>bold</b>");
    expect(out).toContain("<table>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain('href="https://example.com/a"');
  });
});

describe("Safe HTML: no inline images, no embedded SVG", () => {
  const dom = (out: string) => {
    const el = document.createElement("div");
    el.innerHTML = out;
    return el;
  };

  test("images with a data: source (any type) are removed", () => {
    const out = safe('<p>a</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"><img src="DATA:image/gif;base64,R0lGOD"><p>b</p>');
    expect(dom(out).querySelector("img")).toBeNull();
    expect(out).not.toContain("base64");
    expect(out).toContain("<p>a</p>");
    expect(out).toContain("<p>b</p>");
  });

  test("images that point to an inline attachment (cid:) are removed", () => {
    const out = safe('<img src="cid:logo@example.com"><img src="CID:x"><p>t</p>');
    expect(dom(out).querySelector("img")).toBeNull();
    expect(out).toContain("<p>t</p>");
  });

  test("embedded SVG — inline <svg>, and SVG as a data: image — is removed", () => {
    for (const html of [
      '<p>t</p><svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>',
      '<img src="data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22/>">',
      '<img src="data:image/svg+xml;base64,PHN2Zy8+">',
      '<svg><use href="#a"/></svg><svg><foreignObject><p>x</p></foreignObject></svg>',
    ]) {
      const out = safe(html);
      const parsed = dom(out);
      expect(parsed.querySelector("svg, image, use, foreignobject")).toBeNull();
      expect(parsed.querySelector("img")).toBeNull();
      expect(out.toLowerCase()).not.toContain("svg+xml");
    }
    expect(safe('<p>t</p><svg><circle r="1"/></svg>')).toContain("<p>t</p>");
  });

  test("inline images inside a picture/source and CSS background images (data:) are removed too", () => {
    const out = safe(
      '<picture><source srcset="data:image/webp;base64,AAAA"><img src="data:image/png;base64,AAAA"></picture>' +
        '<div style="background-image:url(data:image/png;base64,AAAA);color:red">x</div>' +
        '<style>.a{background:url("data:image/svg+xml;base64,PHN2Zy8+")} .b{color:blue}</style>'
    );
    expect(out).not.toContain("base64");
    expect(out).not.toContain("data:image");
    expect(out).toContain("color:red");
    expect(out).toContain("color:blue"); // the rest of the CSS stays
  });

  test("this holds with 'Show images' on: remote images may come back, inline ones never do", () => {
    const out = sanitizeEmailHtml('<img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA"><svg><circle r="1"/></svg>', {
      allowExternalContent: true,
      stripLinkTracking: true,
      stripInlineImages: true,
    });
    const parsed = dom(out);
    expect(parsed.querySelectorAll("img")).toHaveLength(1);
    expect(parsed.querySelector("img")!.getAttribute("src")).toBe("https://example.com/a.png");
    expect(parsed.querySelector("svg")).toBeNull();
  });

  test("the full HTML view keeps them (it shows the mail as it is — still without script)", () => {
    const out = full('<img src="data:image/png;base64,AAAA"><svg><circle r="1"/></svg>');
    const parsed = dom(out);
    expect(parsed.querySelector("img")?.getAttribute("src")).toContain("data:image/png");
    expect(parsed.querySelector("svg")).not.toBeNull();
    expectNoScript(out);
  });
});

describe("remote content is blocked in Safe HTML (CSS too)", () => {
  test("@import of a remote stylesheet and url(...) in styles are neutralized", () => {
    const out = safe('<style>@import url("https://evil.example/x.css"); @import "https://evil.example/y.css"; .a{background:url(https://evil.example/i.png)} .b{color:red}</style><p>x</p>');
    expect(out).not.toContain("evil.example");
    expect(out).toContain("color:red");
  });
});
