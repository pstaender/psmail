/** Reading and combining the .ics texts stored on a message (see server/services/ics.ts, which writes them). */

export interface IcsEventInfo {
  title: string;
  /** When it starts; a date-only value (an all-day event) is at local midnight. */
  start: Date | null;
  allDay: boolean;
  location: string | null;
}

/** The lines of an iCalendar text, with folded continuation lines joined. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/).filter(line => line !== "");
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function parseIcsDate(value: string): { date: Date; allDay: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (match[4] === undefined) return { date: new Date(year, month - 1, day), allDay: true };

  const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6] ?? 0)];
  return { date: match[7] ? new Date(Date.UTC(year, month - 1, day, hour, minute, second)) : new Date(year, month - 1, day, hour, minute, second), allDay: false };
}

/** What a list needs to say about an event: its title, when and where. */
export function describeIcs(ics: string): IcsEventInfo {
  let title = "";
  let location: string | null = null;
  let start: { date: Date; allDay: boolean } | null = null;

  let inEvent = false;
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") inEvent = true;
    else if (line === "END:VEVENT") break;
    else if (inEvent) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const name = line.slice(0, colon).split(";")[0]!.toUpperCase();
      const value = line.slice(colon + 1);
      if (name === "SUMMARY") title = unescapeText(value);
      else if (name === "LOCATION") location = unescapeText(value);
      else if (name === "DTSTART") start = parseIcsDate(value);
    }
  }
  return { title: title || "(untitled)", start: start?.date ?? null, allDay: start?.allDay ?? false, location };
}

/** A file name for an event's .ics: its title made safe for file systems. */
export function icsFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
  return `${base || "event"}.ics`;
}

/** Several events as one calendar file: the VEVENTs of each text inside a single VCALENDAR. */
export function mergeIcs(list: string[]): string {
  if (list.length === 1) return list[0]!;
  const events = list.flatMap(ics => {
    const lines = unfold(ics);
    const from = lines.indexOf("BEGIN:VEVENT");
    const to = lines.lastIndexOf("END:VEVENT");
    return from === -1 || to < from ? [] : lines.slice(from, to + 1);
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//P.S.Mail//Events found by AI//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...events, "END:VCALENDAR"].join("\r\n") + "\r\n";
}
