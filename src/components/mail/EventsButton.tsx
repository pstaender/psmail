import { CalendarPlus, ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { saveBlob } from "@/lib/api";
import { describeIcs, icsFileName, mergeIcs } from "@/lib/ics";

function when(start: Date | null, allDay: boolean): string {
  if (!start) return "";
  return allDay
    ? start.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })
    : start.toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const saveIcs = (ics: string, filename: string) => saveBlob(new Blob([ics], { type: "text/calendar;charset=utf-8" }), filename);

/**
 * "Found 2 dates": a button for the dates and events the AI found in the message (the "find dates and events" skill). It
 * opens a list with each one — title, date, place — to download as its own calendar file (.ics), and, with several, all of
 * them in one file. Nothing when none were found.
 */
export function EventsButton({ events }: { events: string[] }) {
  if (events.length === 0) return null;
  const described = events.map(ics => ({ ics, ...describeIcs(ics) }));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" title="Download the dates and events found in this message as calendar files (.ics)">
          <CalendarPlus className="size-3.5" /> Found {events.length} {events.length === 1 ? "date" : "dates"}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[min(28rem,90vw)]">
        {described.map((event, index) => (
          <DropdownMenuItem key={index} title={`Download ${icsFileName(event.title)}`} onSelect={() => saveIcs(event.ics, icsFileName(event.title))}>
            <Download className="size-3.5 shrink-0" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{event.title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {[when(event.start, event.allDay), event.location].filter(Boolean).join(" · ")}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        {events.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem title="Download all as one .ics file" onSelect={() => saveIcs(mergeIcs(events), "events.ics")}>
              <Download className="size-3.5" /> All {events.length} in one file
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
