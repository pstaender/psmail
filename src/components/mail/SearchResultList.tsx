import { Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatListDate } from "@/lib/time";
import type { SearchResult } from "../../server/models/search";
import { EmptyState } from "./EmptyState";

function fromLabel(result: SearchResult): string {
  if (result.from.length === 0) return "(no address)";
  const first = result.from[0]!;
  const label = first.name || first.address;
  return result.from.length > 1 ? `${label} +${result.from.length - 1}` : label;
}

export function SearchResultList({
  results,
  loading,
  selectedId,
  onSelect,
}: {
  results: SearchResult[];
  loading: boolean;
  selectedId: number | null;
  onSelect: (result: SearchResult) => void;
}) {
  if (loading && results.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (results.length === 0) {
    return <EmptyState title="No results" description="Try a different search term." />;
  }

  return (
    <ScrollArea className="h-full">
      <ul className="divide-y">
        {results.map(result => (
          <li key={`${result.accountEmail}:${result.id}`}>
            <button
              onClick={() => onSelect(result)}
              className={cn(
                "flex w-full flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-accent/60 transition-colors",
                selectedId === result.id && "bg-accent"
              )}
            >
              <div className="flex items-center gap-2">
                {!result.isRead && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                <span className={cn("flex-1 truncate text-sm", !result.isRead && "font-semibold")}>{fromLabel(result)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatListDate(result.date)}</span>
              </div>
              <div className={cn("truncate text-sm", !result.isRead && "font-medium")}>{result.subject || "(no subject)"}</div>
              <p className="truncate text-xs text-muted-foreground">
                {result.accountEmail} · {result.folder}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
