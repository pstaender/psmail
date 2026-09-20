import { describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { RenderPureMarkdown } from "../../src/components/mail/RenderPureMarkdown";

describe("RenderPureMarkdown", () => {
  test("renders headings, bold, italic, and inline code with de-emphasized markup marks", () => {
    const { container } = render(<RenderPureMarkdown markdown={"## Hello **world** and *there*, `code`"} />);

    const heading = container.querySelector("h2");
    expect(heading).toBeTruthy();
    expect(heading!.querySelector(".md-mark")?.textContent).toBe("##");
    expect(heading!.textContent).toContain("Hello");

    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("**world**");
    expect(strong?.querySelectorAll(".md-mark")).toHaveLength(2);

    const em = container.querySelector("em");
    expect(em?.textContent).toBe("*there*");

    const code = container.querySelector("code");
    expect(code?.textContent).toBe("`code`");

    cleanup();
  });

  test("renders a fenced code block with its fence marks, and the info string", () => {
    const { container } = render(<RenderPureMarkdown markdown={"```js\nconst x = 1;\n```"} />);

    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre!.querySelector("code")?.textContent).toBe("const x = 1;\n");
    expect(pre!.querySelector(".md-info")?.textContent).toBe("js");
    expect(pre!.querySelectorAll(".md-mark")).toHaveLength(2);
  });

  test("renders a real, clickable link with de-emphasized brackets/url, not a fake span", () => {
    const { container } = render(<RenderPureMarkdown markdown="[Example](https://example.com)" />);

    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    expect(link!.getAttribute("href")).toBe("https://example.com/");
    expect(link!.textContent).toBe("Example");
    // target/rel come from the shared sanitizer (same as the Safe HTML tab), not this component.
    expect(link!.getAttribute("target")).toBe("_blank");

    const root = container.querySelector(".psmail-markdown-render")!;
    expect(root.textContent).toContain("[");
    expect(root.textContent).toContain("](https://example.com)");
  });

  test("a link whose text is its own URL shows just the URL, without the [ ](url) marks", () => {
    const cases = [
      "https://example.com",
      "<https://example.com>",
      "[https://example.com](https://example.com)",
    ];
    for (const markdown of cases) {
      const { container, unmount } = render(<RenderPureMarkdown markdown={markdown} />);
      const root = container.querySelector(".psmail-markdown-render")!;
      expect(root.querySelector("a")).toBeTruthy();
      expect(root.querySelector(".md-mark")).toBeNull();
      expect(root.textContent).not.toContain("](");
      unmount();
    }

    const { container } = render(<RenderPureMarkdown markdown="see https://example.com/a?b=1 ok" />);
    expect(container.querySelector(".psmail-markdown-render")!.textContent!.trim()).toBe("see https://example.com/a?b=1 ok");
  });

  test("a link with its own text keeps the brackets and url marks", () => {
    const { container } = render(<RenderPureMarkdown markdown="[Example](https://example.com) and https://other.org" />);
    const root = container.querySelector(".psmail-markdown-render")!;
    expect(root.textContent).toContain("[Example](https://example.com)");
    // Exactly one link has marks (its `[` and `](…)`); the bare one has none.
    expect(root.querySelectorAll(".md-mark")).toHaveLength(2);
    expect(root.querySelectorAll("a")).toHaveLength(2);
  });

  test("a blockquote keeps its `> ` on every line, as de-emphasized marks", () => {
    const { container } = render(<RenderPureMarkdown markdown={"On Monday, Alice wrote:\n> first quoted line\n> second quoted line\n>\n> new paragraph\n\nmy reply"} />);
    const quote = container.querySelector("blockquote")!;
    expect(quote).toBeTruthy();
    expect(quote.textContent!.trim()).toBe("> first quoted line\n> second quoted line\n> new paragraph");
    expect(quote.querySelectorAll(".md-mark")).toHaveLength(3);
    for (const mark of Array.from(quote.querySelectorAll(".md-mark"))) expect(mark.textContent).toBe("> ");

    // Text outside the quote is left alone.
    const root = container.querySelector(".psmail-markdown-render")!;
    expect(root.textContent).toContain("On Monday, Alice wrote:");
    expect(root.textContent).toContain("my reply");
    expect(root.querySelectorAll(".md-mark")).toHaveLength(3);
  });

  test("nested quotes get one `> ` per level, and a heading or code block inside a quote is marked too", () => {
    const { container } = render(<RenderPureMarkdown markdown={"> outer\n>\n> > inner\n>\n> ## Title\n>\n> ```\n> code a\n> code b\n> ```"} />);
    const text = container.querySelector(".psmail-markdown-render")!.textContent!;

    expect(text).toContain("> outer");
    expect(text).toContain("> > inner");
    expect(text).toContain("> ## Title");
    expect(text).toMatch(/> ```\n> code a\n> code b\n> ```/);
  });

  test("quote depth doesn't leak into the next render (or past the quote)", () => {
    const first = render(<RenderPureMarkdown markdown={"> quoted"} />);
    expect(first.container.querySelectorAll(".md-mark")).toHaveLength(1);
    first.unmount();

    const second = render(<RenderPureMarkdown markdown={"plain *text*"} />);
    expect(second.container.textContent).not.toContain(">");
    expect(second.container.querySelectorAll(".md-mark")).toHaveLength(2); // just the emphasis stars
  });

  test("sanitizes the rendered HTML: no script tags, remote images blocked by default", () => {
    const { container } = render(
      <RenderPureMarkdown markdown={"<script>alert(1)</script>\n\n![pic](https://example.com/a.png)"} />
    );

    expect(container.querySelector("script")).toBeNull();
    const img = container.querySelector("img");
    // markdown-it (html: false) already wouldn't pass the <script> through as HTML, but the
    // image src still needs the same "block remote content" treatment as Safe HTML.
    if (img) {
      expect(img.getAttribute("src")).toBeNull();
      expect(img.getAttribute("data-psmail-blocked")).toBe("true");
    }
  });

  test("is not editable — no contenteditable surface anywhere in the output", () => {
    const { container } = render(<RenderPureMarkdown markdown="Just some *text*." />);
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(container.querySelector(".TinyMDE")).toBeNull();
  });

  test("applies aria-label to the render container", () => {
    const { container } = render(<RenderPureMarkdown markdown="Hi" aria-label="Message body" />);
    const root = container.querySelector(".psmail-markdown-render");
    expect(root?.getAttribute("aria-label")).toBe("Message body");
  });
});

describe("RenderPureMarkdown lists", () => {
  test("bullet items keep their hyphen (a de-emphasized mark), as an AI summary is written", () => {
    const summary = "- Frist für Einkommensteuererklärungen 2025 rückt näher\n- Unterlagen bitte bis Ende September (30.09.2026)\n- Rückfragen: +49 2443 911 406";
    const { container } = render(<RenderPureMarkdown markdown={summary} />);

    const items = Array.from(container.querySelectorAll("li"));
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toBe("- Frist für Einkommensteuererklärungen 2025 rückt näher");
    expect(items.every(li => li.querySelector(".md-mark")?.textContent === "- ")).toBe(true);
  });

  test("the marker is the one the source used, and ordered items show their numbers", () => {
    const { container } = render(<RenderPureMarkdown markdown={"* star\n* items\n\n3. third\n4. fourth\n\n1) paren"} />);
    const texts = Array.from(container.querySelectorAll("li")).map(li => li.textContent);
    expect(texts).toEqual(["* star", "* items", "3. third", "4. fourth", "1) paren"]);
  });

  test("nested lists and inline formatting inside items still render", () => {
    const { container } = render(<RenderPureMarkdown markdown={"- outer **bold**\n  - inner one\n  - inner two"} />);
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector("li strong")?.textContent).toBe("**bold**");
    expect(container.querySelector("li li")?.textContent).toBe("- inner one");
  });

  test("a list inside a quote is quoted too", () => {
    const { container } = render(<RenderPureMarkdown markdown={"> - quoted item"} />);
    expect(container.querySelector("blockquote li")?.textContent).toBe("> - quoted item");
  });
});
