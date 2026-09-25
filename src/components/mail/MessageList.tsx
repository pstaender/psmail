import { useEffect, useRef } from "react";
import { Loader2, Paperclip, Star } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatListDate } from "@/lib/time";
import type { EmailRecord } from "../../server/types";
import { CategoryChips } from "./CategoryChips";
import { useUiSettings } from "@/contexts/UiSettingsContext";
import { ConversationMarks } from "./ConversationMarks";
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
  hasMore,
  loadingMore,
  onLoadMore,
  selectedId,
  selectedIds,
  folder,
  onSelect,
  onToggleFlag,
  onEditDraft,
  onOpen = () => {},
  filtered = false,
}: {
  emails: EmailRecord[];
  loading: boolean;
  /** More messages exist beyond those loaded; reaching the end of the list then calls `onLoadMore`. */
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
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
  /** Double-clicking any other message opens it for reading, which lets the app get the list out of the way. */
  onOpen?: (email: EmailRecord) => void;
  /** A date filter is on: an empty list means nothing in that period, not an empty folder. */
  filtered?: boolean;
}) {
  const { showConversations, showCategories, showAbsoluteDates } = useUiSettings();
  const sentinelRef = useRef<HTMLLIElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  // Fires whenever the end-of-list marker scrolls into (or near) view. Depends on `emails.length` so
  // that, if a freshly loaded page still doesn't fill the viewport, the marker is re-observed and the
  // next page is requested too.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onLoadMoreRef.current();
    }, { rootMargin: "300px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, emails.length]);

  if (loading && emails.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (emails.length === 0) {
    return <EmptyState title="No messages" description={filtered ? "Nothing matches the filter." : "This folder is empty."} />;
  }

  return (
    <ScrollArea className="h-full">
      <ul className="divide-y">
        {emails.map(email => (
          <li key={email.id} data-row-id={email.id}>
            <button
              onClick={e => onSelect(email, e)}
              onDoubleClick={e => {
                if (email.isDraft) onEditDraft(email);
                else if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onOpen(email);
              }}
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
                <span className="shrink-0 text-xs text-muted-foreground">{formatListDate(email.date, { forceDate: showAbsoluteDates })}</span>
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
                <span className="flex-1 truncate">{email.subject || "(no subject)"}</span>
                {showConversations && <ConversationMarks conversation={email.conversation} />}
                {((email.attachmentCount ?? email.attachments?.length) ?? 0) > 0 && (
                  <Paperclip aria-label="Has attachments" className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </div>
              {email.plainText && (
                <p className="truncate text-xs text-muted-foreground">{email.plainText.replace(/\s+/g, " ").trim()}</p>
              )}
              {showCategories && <CategoryChips labels={email.taxonomyList} />}
            </button>
          </li>
        ))}
        {hasMore && (
          <li ref={sentinelRef} className="flex h-10 items-center justify-center text-muted-foreground">
            {loadingMore && <Loader2 className="size-4 animate-spin" />}
          </li>
        )}
      </ul>
    </ScrollArea>
  );
}
