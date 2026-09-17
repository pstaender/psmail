import { useMemo, useState } from "react";
import { ImageOff, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { HtmlFrame } from "./HtmlFrame";
import type { EmailRecord } from "../../server/types";

const HAS_REMOTE_IMG = /<img[^>]+src=["']https?:\/\//i;

function PlainTextView({ text }: { text: string }) {
  return <pre className="whitespace-pre-wrap break-words p-4 font-sans text-sm">{text}</pre>;
}

export function MessageBody({ email }: { email: EmailRecord }) {
  const [showExternal, setShowExternal] = useState(false);

  const hasHtml = !!email.htmlText;
  const hasPlain = !!email.plainText;
  const defaultTab = hasHtml ? "safe" : "plain";

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

  if (!hasHtml && !hasPlain) {
    return <p className="p-4 text-sm text-muted-foreground">This message has no readable body.</p>;
  }

  return (
    <Tabs key={email.id} defaultValue={defaultTab} className="gap-0">
      <TabsList className="mx-4 mt-3 w-fit">
        {hasPlain && <TabsTrigger value="plain">Plain text</TabsTrigger>}
        {hasHtml && <TabsTrigger value="safe">Safe HTML</TabsTrigger>}
        {hasHtml && <TabsTrigger value="full">Full HTML</TabsTrigger>}
      </TabsList>

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
