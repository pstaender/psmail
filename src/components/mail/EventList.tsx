import { useState } from "react";
import { CalendarPlus, ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
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
 * Collapsed to a line saying how many there are: the pointer over it opens the list (and moving away closes it), a click
 * keeps it open (which is also how touch screens get to it) until clicked again.
 */
export function EventList({ events }: { events: string[] }) {
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  // A click that closes it while the pointer is still over it must keep it closed, until the pointer has left.
  const [closedByClick, setClosedByClick] = useState(false);
  if (events.length === 0) return null;
  const described = events.map(ics => ({ ics, ...describeIcs(ics) }));
  const open = pinned || (hovering && !closedByClick);
  const count = `${events.length} ${events.length === 1 ? "date or event" : "dates and events"}`;

  return (
    <Collapsible
      open={open}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false);
        setClosedByClick(false);
      }}
      className="border-b bg-muted/20 px-4 py-1.5"
      aria-label="Dates and events"
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 py-0.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        title={described.map(event => event.title).join("\n")}
        onClick={() => {
          // Hovering already opened it: a click then keeps it open; a click on a kept-open one closes it.
          setPinned(!pinned);
          setClosedByClick(pinned);
        }}
      >
        <CalendarPlus className="size-3.5" /> {count}
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-1.5 pb-1.5 pt-1">
        {events.length > 1 && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" title="Download all as one .ics file" onClick={() => saveIcs(mergeIcs(events), "events.ics")}>
            <Download className="size-3.5" /> All ({events.length})
          </Button>
        )}
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
      </CollapsibleContent>
    </Collapsible>
  );
}
