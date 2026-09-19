import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { EmailRecord } from "../../server/types";
import { RenderPureMarkdown } from "./RenderPureMarkdown";

/** What the AI made of a message — its summary and 2-6 category labels — kept on the message once computed. Renders nothing until there is something. */
export function AiSummaryPanel({ email }: { email: EmailRecord }) {
  const labels = email.taxonomyList ?? [];
  if (!email.aiSummary && labels.length === 0) return null;

  return (
    <div className="space-y-2 border-b bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5" /> {email.aiSummary ? "AI summary" : "AI categories"}
      </div>
      {email.aiSummary && <RenderPureMarkdown markdown={email.aiSummary} aria-label="AI summary" className="text-sm" />}
      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Categories">
          {labels.map(label => (
            <li key={label}>
              <Badge variant="secondary">{label}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
