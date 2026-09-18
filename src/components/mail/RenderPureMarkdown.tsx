import { useMemo } from "react";
import MarkdownIt from "markdown-it";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { cn } from "@/lib/utils";
import "./tinyMarkdownEditor.css";

/**
 * A single shared MarkdownIt instance with custom renderer rules that wrap markup characters
 * (`#`, `**`, `` ` ``, ...) in `<span class="md-mark">` — de-emphasized via CSS rather than
 * hidden, matching MarkdownEditor/TinyMDE's "plain markdown, lightly de-emphasized syntax"
 * look (see tinyMarkdownEditor.css's `.psmail-markdown-render` rules). `html: false` keeps
 * markdown-it from ever emitting raw HTML found in the source; `breaks: true` turns a single
 * newline into a line break, matching how this content used to render in a plain `<pre>`.
 */
// Derived structurally (rather than naming `MarkdownIt.Token` directly) because a default
// import of this CJS `export =` module doesn't reliably carry its merged namespace into type
// position here — this gets the same type without depending on that.
type RenderRule = NonNullable<InstanceType<typeof MarkdownIt>["renderer"]["rules"][string]>;
type Token = Parameters<RenderRule>[0][number];

function createRenderer(): InstanceType<typeof MarkdownIt> {
  const instance = new MarkdownIt({ html: false, linkify: true, breaks: true });
  const esc = instance.utils.escapeHtml;
  const mark = (text: string) => `<span class="md-mark">${esc(text)}</span>`;
  const rules = instance.renderer.rules;

  rules.heading_open = (tokens: Token[], idx: number) => `<${tokens[idx]!.tag}>${mark(tokens[idx]!.markup)} `;
  rules.heading_close = (tokens: Token[], idx: number) => `</${tokens[idx]!.tag}>`;

  rules.strong_open = (tokens: Token[], idx: number) => `<strong>${mark(tokens[idx]!.markup)}`;
  rules.strong_close = (tokens: Token[], idx: number) => `${mark(tokens[idx]!.markup)}</strong>`;

  rules.em_open = (tokens: Token[], idx: number) => `<em>${mark(tokens[idx]!.markup)}`;
  rules.em_close = (tokens: Token[], idx: number) => `${mark(tokens[idx]!.markup)}</em>`;

  rules.s_open = (tokens: Token[], idx: number) => `<s>${mark(tokens[idx]!.markup)}`;
  rules.s_close = (tokens: Token[], idx: number) => `${mark(tokens[idx]!.markup)}</s>`;

  rules.code_inline = (tokens: Token[], idx: number) => {
    const token = tokens[idx]!;
    return `<code>${mark(token.markup)}${esc(token.content)}${mark(token.markup)}</code>`;
  };

  rules.fence = (tokens: Token[], idx: number) => {
    const token = tokens[idx]!;
    const fenceMark = token.markup || "```";
    const info = token.info.trim();
    const infoHtml = info ? ` <span class="md-info">${esc(info)}</span>` : "";
    return `<pre>${mark(fenceMark)}${infoHtml}\n<code>${esc(token.content)}</code>${mark(fenceMark)}</pre>\n`;
  };

  // link_open and link_close are separate renderer calls, but a link's text can never contain
  // another link, so stashing the href in between them (rather than threading it through some
  // other way) is safe — by the time link_close for THIS link runs, no other link_open could
  // have overwritten it.
  let linkHref = "";
  rules.link_open = (tokens: Token[], idx: number) => {
    const href = tokens[idx]!.attrGet("href");
    linkHref = href === null ? "" : String(href);
    return `${mark("[")}<a href="${esc(linkHref)}">`;
  };
  rules.link_close = () => `</a>${mark(`](${linkHref})`)}`;

  return instance;
}

const markdownIt = createRenderer();

/**
 * Renders markdown as real, inert HTML — no editing, no contenteditable surface, just
 * `markdown-it` output run through the same DOMPurify-based sanitizer used for the Safe HTML
 * tab (`allowExternalContent: false` blocks remote images the same way; `stripLinkTracking`
 * cleans link hrefs). Styled via `.psmail-markdown-render` in tinyMarkdownEditor.css to look
 * like MarkdownEditor/TinyMDE's output, even though the two don't share any DOM structure.
 */
export function RenderPureMarkdown({
  markdown,
  className,
  "aria-label": ariaLabel,
}: {
  markdown: string;
  className?: string;
  "aria-label"?: string;
}) {
  const html = useMemo(() => {
    const rendered = markdownIt.render(markdown);
    return sanitizeEmailHtml(rendered, { allowExternalContent: false, stripLinkTracking: true });
  }, [markdown]);

  return (
    <div
      className={cn("psmail-markdown-render", className)}
      aria-label={ariaLabel}
      // Safe: markdown-it can't emit raw HTML from the source (html: false above), and the
      // result is still run through the same sanitizer as every other rendered-HTML view.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
