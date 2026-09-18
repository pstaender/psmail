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
