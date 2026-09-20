import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { EmailRecord } from "../../server/types";
import type { AiSkillRecord } from "../../server/models/ai";
import { AiSkillButton } from "./AiSkillButton";
import { EventsButton } from "./EventsButton";
import { RenderPureMarkdown } from "./RenderPureMarkdown";

/**
 * The content of the "Summary" tab: what the AI made of the message — its summary and 2-6 category labels,
 * kept on the message once computed — and a button to (re)generate them. Before there is a summary it says
 * so and offers to make one.
 */
export function AiSummaryPanel({
  email,
  skills,
  busy,
  onSummarize,
}: {
  email: EmailRecord;
  /** The user's Summarize skills (empty: no button, just what is stored). */
  skills: AiSkillRecord[];
  busy: boolean;
  onSummarize: (skillId: number) => void;
}) {
  const labels = email.taxonomyList ?? [];

  return (
    <div className="space-y-3 p-4">
      {email.aiSummary ? (
        <RenderPureMarkdown markdown={email.aiSummary} aria-label="AI summary" />
      ) : skills.length > 0 ? (
        <p className="text-sm text-muted-foreground">No summary yet. The AI summarizes this message when you press the button.</p>
      ) : null}

      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Categories">
          {labels.map(label => (
            <li key={label}>
              <Badge variant="secondary">{label}</Badge>
            </li>
          ))}
        </ul>
      )}

      {/* Between the categories and the button to summarize again: what was found in the message. */}
      <div className="flex flex-wrap items-center gap-2">
        <EventsButton events={email.calendarEvents ?? []} />
        <AiSkillButton
          skills={skills}
          busy={busy}
          icon={<Sparkles className="size-3.5" />}
          label={email.aiSummary ? "Summarize again" : "Summarize with AI"}
          variant="outline"
          onRun={onSummarize}
        />
      </div>
    </div>
  );
}
