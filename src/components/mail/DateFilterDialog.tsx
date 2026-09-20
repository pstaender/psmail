import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MODE_LABELS, today, validateFilter, type DateFilter, type DateFilterMode } from "@/lib/dateFilter";

const MODES: DateFilterMode[] = ["day", "range", "since", "before"];

const HINTS: Record<DateFilterMode, string> = {
  day: "Only the messages of that day.",
  range: "The messages from the first day to the last day, both included.",
  since: "That day and everything newer.",
  before: "Everything older than that day (the day itself isn't included).",
};

function blank(mode: DateFilterMode, from: DateFilter | null): DateFilter {
  const day = from ? ("day" in from ? from.day : from.from) : today();
  return mode === "range" ? { mode, from: day, to: from?.mode === "range" ? from.to : day } : { mode, day };
}

/** Sets which messages of the list to show by date: one day, a range, or everything since / before a day. */
export function DateFilterDialog({
  open,
  onOpenChange,
  value,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The filter in effect, if any. */
  value: DateFilter | null;
  /** The new filter, or null to show everything again. */
  onApply: (filter: DateFilter | null) => void;
}) {
  const [filter, setFilter] = useState<DateFilter>(() => value ?? blank("day", null));
  useEffect(() => {
    if (open) setFilter(value ?? blank("day", null));
  }, [open, value]);

  const problem = validateFilter(filter);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          noValidate
          className="space-y-4"
          onSubmit={e => {
            e.preventDefault();
            if (problem) return;
            onApply(filter);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Filter by date</DialogTitle>
            <DialogDescription>Show only the messages of this list from a day or period.</DialogDescription>
          </DialogHeader>

          <div role="radiogroup" aria-label="Kind of filter" className="grid grid-cols-2 gap-1.5">
            {MODES.map(mode => (
              <Button
                key={mode}
                type="button"
                role="radio"
                aria-checked={filter.mode === mode}
                variant={filter.mode === mode ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(blank(mode, filter))}
              >
                {MODE_LABELS[mode]}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{HINTS[filter.mode]}</p>

          {filter.mode === "range" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="date-filter-from">From</Label>
                <Input id="date-filter-from" type="date" value={filter.from} onChange={e => setFilter({ ...filter, from: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="date-filter-to">To</Label>
                <Input id="date-filter-to" type="date" value={filter.to} min={filter.from} onChange={e => setFilter({ ...filter, to: e.target.value })} />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="date-filter-day">{filter.mode === "day" ? "Day" : filter.mode === "since" ? "Since" : "Before"}</Label>
              <Input id="date-filter-day" type="date" value={filter.day} onChange={e => setFilter({ ...filter, day: e.target.value } as DateFilter)} />
            </div>
          )}

          {problem && <p className="text-sm text-destructive">{problem}</p>}

          <DialogFooter>
            {value && (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                onClick={() => {
                  onApply(null);
                  onOpenChange(false);
                }}
              >
                Clear filter
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={problem !== null}>
              Apply
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
