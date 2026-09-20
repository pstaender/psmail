import { CalendarPlus, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
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
 * The dates and events the AI found in the message (see the "find dates and events" skill), each offered as a calendar
 * file (.ics) to download, and — with several — all of them in one file. Shown below the attachments; nothing when none.
 */
export function EventList({ events }: { events: string[] }) {
  if (events.length === 0) return null;
  const described = events.map(ics => ({ ics, ...describeIcs(ics) }));

  return (
    <div className="space-y-1.5 border-b bg-muted/20 px-4 py-3" aria-label="Dates and events">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <CalendarPlus className="size-3.5" /> Dates and events
        {events.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            title="Download all as one .ics file"
            onClick={() => saveIcs(mergeIcs(events), "events.ics")}
          >
            <Download className="size-3.5" /> All ({events.length})
          </Button>
        )}
      </div>
      <ul className="flex flex-wrap gap-2">
        {described.map((event, index) => (
          <li key={index}>
            <button
              onClick={() => saveIcs(event.ics, icsFileName(event.title))}
              title={`Download ${icsFileName(event.title)}`}
              className="group flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-left text-xs hover:bg-accent"
            >
              <span className="max-w-56 truncate font-medium">{event.title}</span>
              <span className="text-muted-foreground">{when(event.start, event.allDay)}</span>
              {event.location && <span className="max-w-40 truncate text-muted-foreground">· {event.location}</span>}
              <Download className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
