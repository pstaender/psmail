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

  // Blockquotes keep their mail syntax: every line inside one starts with a de-emphasized `> ` (`> > ` when
  // nested), like the quoted lines of a reply in the source. markdown-it renders tokens strictly in order, so a
  // counter tracks how deep in quotes the current token is.
  let quoteDepth = 0;
  const quotePrefix = () => (quoteDepth > 0 ? mark("> ".repeat(quoteDepth)) : "");
  rules.blockquote_open = (tokens: Token[], idx: number, options, _env, self) => {
    quoteDepth += 1;
    return self.renderToken(tokens, idx, options);
  };
  rules.blockquote_close = (tokens: Token[], idx: number, options, _env, self) => {
    quoteDepth = Math.max(quoteDepth - 1, 0);
    return self.renderToken(tokens, idx, options);
  };
  rules.paragraph_open = (tokens: Token[], idx: number, options, _env, self) =>
    self.renderToken(tokens, idx, options) + (tokens[idx]!.hidden ? "" : quotePrefix());
  // The soft/hard line breaks inside a quoted paragraph start the next quoted line.
  rules.softbreak = () => `<br>\n${quotePrefix()}`;
  rules.hardbreak = () => `<br>\n${quotePrefix()}`;

  rules.heading_open = (tokens: Token[], idx: number) => `<${tokens[idx]!.tag}>${quotePrefix()}${mark(tokens[idx]!.markup)} `;
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
    const prefix = quotePrefix();
    // Inside a quote every line of the fenced block carries the `> ` too.
    const code = prefix
      ? token.content.replace(/\n$/, "").split("\n").map(line => prefix + esc(line)).join("\n") + "\n"
      : esc(token.content);
    return `<pre>${prefix}${mark(fenceMark)}${infoHtml}\n<code>${code}</code>${prefix}${mark(fenceMark)}</pre>\n`;
  };

  // link_open and link_close are separate renderer calls, but a link's text can never contain
  // another link, so stashing state in between them (rather than threading it through some
  // other way) is safe — by the time link_close for THIS link runs, no other link_open could
  // have overwritten it.
  //
  // The `[`/`](url)` syntax marks are only worth showing when the link has text of its own: a
  // bare URL (linkify, `<https://…>`, or `[https://x](https://x)`) already *is* its address, so
  // it renders as just the URL instead of repeating it inside brackets.
  let linkHref = "";
  let linkIsBareUrl = false;
  rules.link_open = (tokens: Token[], idx: number) => {
    const token = tokens[idx]!;
    const href = token.attrGet("href");
    linkHref = href === null ? "" : String(href);

    const next = tokens[idx + 1];
    const textIsUrl =
      next?.type === "text" && tokens[idx + 2]?.type === "link_close" && (next.content === linkHref || `mailto:${next.content}` === linkHref);
    linkIsBareUrl = token.markup === "linkify" || token.markup === "autolink" || textIsUrl;

    return `${linkIsBareUrl ? "" : mark("[")}<a href="${esc(linkHref)}">`;
  };
  rules.link_close = () => `</a>${linkIsBareUrl ? "" : mark(`](${linkHref})`)}`;

  // A render that threw halfway must not leave the next one thinking it's inside a quote.
  const render = instance.render.bind(instance);
  instance.render = (src, env) => {
    quoteDepth = 0;
    return render(src, env);
  };

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
