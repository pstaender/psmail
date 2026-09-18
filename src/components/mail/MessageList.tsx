import { Loader2, Paperclip, Star } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatListDate } from "@/lib/time";
import type { EmailRecord } from "../../server/types";
import { EmptyState } from "./EmptyState";

function participantLabel(email: EmailRecord, folder: string): string {
  const list = folder === "Sent" || folder === "Drafts" ? email.to : email.from;
  if (list.length === 0) return "(no address)";
  const first = list[0]!;
  const label = first.name || first.address;
  return list.length > 1 ? `${label} +${list.length - 1}` : label;
}

export function MessageList({
  emails,
  loading,
  selectedId,
  selectedIds,
  folder,
  onSelect,
  onToggleFlag,
  onEditDraft,
}: {
  emails: EmailRecord[];
  loading: boolean;
  /** The single message currently open in the reading pane. */
  selectedId: number | null;
  /** Messages checked for a bulk action (via Cmd/Ctrl+click) — independent of `selectedId`. */
  selectedIds: Set<number>;
  folder: string;
  /** `event` carries the click's modifier keys so the caller can decide plain-click-to-read vs Cmd/Ctrl-click-to-toggle-selection. */
  onSelect: (email: EmailRecord, event: React.MouseEvent) => void;
  onToggleFlag: (email: EmailRecord) => void;
  /** Double-clicking a draft opens it for editing directly, instead of just reading it. */
  onEditDraft: (email: EmailRecord) => void;
}) {
  if (loading && emails.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (emails.length === 0) {
    return <EmptyState title="No messages" description="This folder is empty." />;
  }

  return (
    <ScrollArea className="h-full">
      <ul className="divide-y">
        {emails.map(email => (
          <li key={email.id}>
            <button
              onClick={e => onSelect(email, e)}
              onDoubleClick={() => email.isDraft && onEditDraft(email)}
              className={cn(
                "group flex w-full flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-accent/60 transition-colors",
                selectedId === email.id && "bg-accent",
                selectedIds.has(email.id) && "bg-primary/10 ring-1 ring-inset ring-primary/50"
              )}
            >
              <div className="flex items-center gap-2">
                {!email.isRead && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                <span className={cn("flex-1 truncate text-sm", !email.isRead && "font-semibold")}>
                  {participantLabel(email, folder)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatListDate(email.date)}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={e => {
                    e.stopPropagation();
                    onToggleFlag(email);
                  }}
                  className="shrink-0"
                >
                  <Star
                    className={cn(
                      "size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-yellow-500",
                      email.isFlagged && "fill-yellow-400 text-yellow-500 opacity-100"
                    )}
                  />
                </span>
              </div>
              <div className={cn("flex items-center gap-1.5 truncate text-sm", !email.isRead && "font-medium")}>
                {(email.attachments?.length ?? 0) > 0 && <Paperclip className="size-3 shrink-0 text-muted-foreground" />}
                <span className="truncate">{email.subject || "(no subject)"}</span>
              </div>
              {email.plainText && (
                <p className="truncate text-xs text-muted-foreground">{email.plainText.replace(/\s+/g, " ").trim()}</p>
              )}
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
