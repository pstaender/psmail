import { useEffect, useRef } from "react";
import { Loader2, Paperclip, Star } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatListDate } from "@/lib/time";
import type { SearchResult } from "../../server/models/search";
import { EmptyState } from "./EmptyState";
import { CategoryChips } from "./CategoryChips";
import { useUiSettings } from "@/contexts/UiSettingsContext";
import { ConversationMarks } from "./ConversationMarks";

function participantLabel(result: SearchResult, showRecipient: boolean): string {
  const list = showRecipient && result.to ? result.to : result.from;
  if (list.length === 0) return "(no address)";
  const first = list[0]!;
  const label = first.name || first.address;
  return list.length > 1 ? `${label} +${list.length - 1}` : label;
}

export function SearchResultList({
  results,
  loading,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  showRecipient = false,
  onToggleFlag,
  selectedId,
  selectedIds,
  onSelect,
  onOpen = () => {},
  filtered = false,
}: {
  results: SearchResult[];
  loading: boolean;
  /** More results exist beyond those loaded; reaching the end of the list then calls `onLoadMore`. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Label each row with who it was sent to (the unified Sent list) instead of who it's from. */
  showRecipient?: boolean;
  /** Clicking a row's star flags/unflags that message. */
  onToggleFlag?: (result: SearchResult) => void;
  selectedId: number | null;
  /** Rows checked for a bulk action (Cmd/Ctrl/Shift+click) — independent of `selectedId`, the one open in the reading pane. */
  selectedIds: Set<number>;
  /** `event` carries the click's modifier keys, so the caller can tell a plain click from a selection click. */
  onSelect: (result: SearchResult, event: React.MouseEvent) => void;
  /** Double-clicking a result opens it for reading, which lets the app get the list out of the way. */
  onOpen?: (result: SearchResult) => void;
  /** A date filter is on: an empty list means nothing in that period. */
  filtered?: boolean;
}) {
  const { showConversations, showCategories, showAbsoluteDates } = useUiSettings();
  const sentinelRef = useRef<HTMLLIElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  // Same end-of-list trigger as MessageList; re-observed as results.length grows so a page that
  // still doesn't fill the viewport pulls in the next one.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onLoadMoreRef.current?.();
    }, { rootMargin: "300px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, results.length]);

  if (loading && results.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (results.length === 0) {
    return <EmptyState title={filtered ? "No messages" : "No results"} description={filtered ? "Nothing matches the filter." : "Try a different search term."} />;
  }

  return (
    <ScrollArea className="h-full">
      <ul className="divide-y">
        {results.map(result => (
          <li key={`${result.accountEmail}:${result.id}`} data-row-id={result.id}>
            <button
              onClick={e => onSelect(result, e)}
              onDoubleClick={e => {
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onOpen(result);
              }}
              className={cn(
                "group flex w-full flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-accent/60 transition-colors",
                selectedId === result.id && "bg-accent",
                selectedIds.has(result.id) && "bg-primary/10 ring-1 ring-inset ring-primary/50"
              )}
            >
              <div className="flex items-center gap-2">
                {!result.isRead && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                <span className={cn("flex-1 truncate text-sm", !result.isRead && "font-semibold")}>{participantLabel(result, showRecipient)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatListDate(result.date, { forceDate: showAbsoluteDates })}</span>
                <span
                  role="button"
                  tabIndex={0}
                  title={result.isFlagged ? "Remove star" : "Add star"}
                  onClick={e => {
                    e.stopPropagation();
                    onToggleFlag?.(result);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onToggleFlag?.(result);
                    }
                  }}
                  className="shrink-0"
                >
                  <Star
                    aria-label={result.isFlagged ? "Starred" : undefined}
                    className={cn(
                      "size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-yellow-500",
                      result.isFlagged && "fill-yellow-400 text-yellow-500 opacity-100"
                    )}
                  />
                </span>
              </div>
              <div className={cn("flex items-center gap-1.5 text-sm", !result.isRead && "font-medium")}>
                <span className="flex-1 truncate">{result.subject || "(no subject)"}</span>
                {showConversations && <ConversationMarks conversation={result.conversation} />}
                {result.hasAttachments && <Paperclip aria-label="Has attachments" className="size-3.5 shrink-0 text-muted-foreground" />}
              </div>
              {showCategories && <CategoryChips labels={result.taxonomyList} />}
              <p className="truncate text-xs text-muted-foreground">
                {result.accountEmail} · {result.folder}
              </p>
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
