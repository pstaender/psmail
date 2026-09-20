import { Badge } from "@/components/ui/badge";

/** How many categories a list row shows before "+N" (the row's tooltip has them all). */
const SHOWN = 3;

/** A message's categories (the AI's taxonomy labels) as small chips, for the message lists. Nothing without any. */
export function CategoryChips({ labels }: { labels?: string[] | null }) {
  const list = (labels ?? []).filter(label => typeof label === "string" && label !== "");
  if (list.length === 0) return null;

  const shown = list.slice(0, SHOWN);
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Categories" title={list.join(", ")}>
      {shown.map(label => (
        <li key={label}>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
            {label}
          </Badge>
        </li>
      ))}
      {list.length > shown.length && (
        <li>
          <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
            +{list.length - shown.length}
          </Badge>
        </li>
      )}
    </ul>
  );
}
