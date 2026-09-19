import "./MessageBody.css";
import { useMemo, useState } from "react";
import { ImageOff, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { buildClearestText, markdownFromHtml } from "@/lib/textView";
import { HtmlFrame } from "./HtmlFrame";
import { RenderPureMarkdown } from "./RenderPureMarkdown";
import type { EmailRecord } from "../../server/types";

const HAS_REMOTE_IMG = /<img[^>]+src=["']https?:\/\//i;

export type BodyView = "text" | "md" | "plain" | "safe" | "full";

/**
 * Picks which tab a (possibly new) message should open on: reuses the
 * caller's remembered choice when it's available for this message, but
 * never carries "full" across to a message the user hasn't explicitly
 * chosen it for — downgrades to "safe" instead. Falls back to the same
 * default the app always used (Safe HTML if there's HTML, else Plain)
 * when there's no usable remembered choice.
 */
export function resolveInitialView(
  preferred: BodyView | null,
  availability: { text: boolean; plain: boolean; html: boolean }
): BodyView {
  const candidate = preferred === "full" ? "safe" : preferred;

  if (candidate === "text" && availability.text) return "text";
  if (candidate === "md" && availability.html) return "md";
  if (candidate === "plain" && availability.plain) return "plain";
  if (candidate === "safe" && availability.html) return "safe";

  return availability.html ? "safe" : "plain";
}

function PlainTextView({ text }: { text: string }) {
  return <pre className="whitespace-pre-wrap break-words p-4 font-mono text-sm plain-text-view">{text}</pre>;
}

/** Renders markdown looking like the compose editor (inline formatting, de-emphasized markup) instead of a raw/plain text dump — used for the "Text" and "MD" tabs, both of which are markdown, unlike "Plain text" (the literal MIME plain-text part). Non-editable, real HTML — see RenderPureMarkdown. */
function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="p-4">
      <RenderPureMarkdown markdown={text} aria-label="Message body" />
    </div>
  );
}

export function MessageBody({
  email,
  preferredView,
  onViewChange,
}: {
  email: EmailRecord;
  preferredView: BodyView | null;
  /** Called only when the user picks a tab — never for an automatic fallback — so it's safe to remember/persist. */
  onViewChange: (view: BodyView) => void;
}) {
  const [showExternal, setShowExternal] = useState(false);

  const hasHtml = !!email.htmlText;
  const hasPlain = !!email.plainText;

  const clearestText = useMemo(
    () => buildClearestText({ plainText: email.plainText, htmlText: email.htmlText }),
    [email.plainText, email.htmlText]
  );

  // Unlike "Text" (which prefers the plain-text part when there is one), "MD" always shows
  // the HTML converted to Markdown, whenever there's HTML at all.
  const markdownContent = useMemo(() => (email.htmlText ? markdownFromHtml(email.htmlText) : null), [email.htmlText]);

  const mightHaveRemoteImages = useMemo(() => (email.htmlText ? HAS_REMOTE_IMG.test(email.htmlText) : false), [email.htmlText]);

  const safeHtml = useMemo(
    () =>
      email.htmlText
        ? sanitizeEmailHtml(email.htmlText, { allowExternalContent: showExternal, stripLinkTracking: true })
        : "",
    [email.htmlText, showExternal]
  );

  const fullHtml = useMemo(
    () => (email.htmlText ? sanitizeEmailHtml(email.htmlText, { allowExternalContent: true, stripLinkTracking: false }) : ""),
    [email.htmlText]
  );

  // Resolved fresh per message (not per preferredView change): reuses the remembered tab if it's
  // available here — falling back to another one when it isn't (e.g. MD on a plain-text-only mail)
  // WITHOUT touching the remembered choice, so the next mail that has it opens on it again — and
  // downgrading "full" to "safe" for a message the user hasn't explicitly picked it for. Depending
  // only on email.id keeps this stable while the user is still on the same message.
  const initialView = useMemo(
    () => resolveInitialView(preferredView, { text: clearestText !== null, plain: hasPlain, html: hasHtml }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [email.id]
  );

  if (!hasHtml && !hasPlain) {
    return <p className="p-4 text-sm text-muted-foreground">This message has no readable body.</p>;
  }

  return (
    <Tabs key={email.id} defaultValue={initialView} onValueChange={value => onViewChange(value as BodyView)} className="gap-0">
      <TabsList className="mx-4 mt-3 w-fit">
        {clearestText !== null && <TabsTrigger value="text">Text</TabsTrigger>}
        {hasHtml && <TabsTrigger value="md">MD</TabsTrigger>}
        {hasPlain && <TabsTrigger value="plain">Plain</TabsTrigger>}
        {hasHtml && <TabsTrigger value="safe">Safe HTML</TabsTrigger>}
        {hasHtml && <TabsTrigger value="full">HTML</TabsTrigger>}
      </TabsList>

      {clearestText !== null && (
        <TabsContent value="text">
          <MarkdownPreview text={clearestText} />
        </TabsContent>
      )}

      {hasHtml && (
        <TabsContent value="md">
          <MarkdownPreview text={markdownContent!} />
        </TabsContent>
      )}

      {hasPlain && (
        <TabsContent value="plain">
          <PlainTextView text={email.plainText!} />
        </TabsContent>
      )}

      {hasHtml && (
        <TabsContent value="safe">
          {mightHaveRemoteImages && !showExternal && (
            <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <ImageOff className="size-3.5" /> External images blocked
              </span>
              <Button size="sm" variant="secondary" className="h-7" onClick={() => setShowExternal(true)}>
                Show images
              </Button>
            </div>
          )}
          <HtmlFrame html={safeHtml} />
        </TabsContent>
      )}

      {hasHtml && (
        <TabsContent value="full">
          <div className="mx-4 mt-3 flex items-center gap-1.5 rounded-md border bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <ShieldAlert className="size-3.5" />
            Showing this message as originally sent, including remote content and unmodified links.
          </div>
          <HtmlFrame html={fullHtml} />
        </TabsContent>
      )}
    </Tabs>
  );
}
