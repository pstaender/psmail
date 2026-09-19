import { Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EmailRecord } from "../../server/types";
import { RenderPureMarkdown } from "./RenderPureMarkdown";

/**
 * The content of the "Summary" tab: what the AI made of the message — its summary and 2-6 category labels,
 * kept on the message once computed — and a button to (re)generate them. Before there is a summary it says
 * so and offers to make one.
 */
export function AiSummaryPanel({
  email,
  canSummarize,
  busy,
  onSummarize,
}: {
  email: EmailRecord;
  canSummarize: boolean;
  busy: boolean;
  onSummarize: () => void;
}) {
  const labels = email.taxonomyList ?? [];

  return (
    <div className="space-y-3 p-4">
      {email.aiSummary ? (
        <RenderPureMarkdown markdown={email.aiSummary} aria-label="AI summary" />
      ) : (
        <p className="text-sm text-muted-foreground">No summary yet. The AI summarizes this message when you press the button.</p>
      )}

      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Categories">
          {labels.map(label => (
            <li key={label}>
              <Badge variant="secondary">{label}</Badge>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canSummarize || busy}
        title={canSummarize ? undefined : "Set up a Summarize skill in Settings → AI"}
        onClick={onSummarize}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        {email.aiSummary ? "Summarize again" : "Summarize with AI"}
      </Button>
    </div>
  );
}
