import { describe, expect, test } from "bun:test";
import { buildIcs, escapeIcsText, foldIcsLine, icsFromAnswer, MAX_EVENTS, parseEventsAnswer } from "../../src/server/services/ics";

const NOW = new Date("2026-09-01T10:00:00Z");
const line = (ics: string, prefix: string) => ics.split("\r\n").find(l => l.startsWith(prefix));

describe("parseEventsAnswer", () => {
  test("reads a JSON array — bare, in a code fence, or between other words", () => {
    const list = '[{"title":"A","start":"2026-09-30"}]';
    for (const answer of [list, "```json\n" + list + "\n```", `Here you go: ${list} Hope it helps.`]) {
      expect(parseEventsAnswer(answer)).toEqual([{ title: "A", start: "2026-09-30" }]);
    }
  });

  test("keeps the optional fields, accepts summary/notes as names, and trims", () => {
    expect(parseEventsAnswer('[{"summary":" Call ","start":"2026-10-02T14:00","end":"2026-10-02T14:30","location":" Berlin ","notes":"bring papers"}]')).toEqual([
      { title: "Call", start: "2026-10-02T14:00", end: "2026-10-02T14:30", location: "Berlin", description: "bring papers" },
    ]);
  });

  test("drops what can't be a calendar entry: no title, not a real date, garbage, not an array", () => {
    const answer = JSON.stringify([
      { start: "2026-09-30" },
      { title: "No date" },
      { title: "Bad date", start: "next week" },
      { title: "Feb 30", start: "2026-02-30" },
      { title: "Hour 25", start: "2026-09-30T25:00" },
      "text",
      null,
      { title: "Fine", start: "2026-09-30" },
    ]);
    expect(parseEventsAnswer(answer).map(e => e.title)).toEqual(["Fine"]);
    expect(parseEventsAnswer("no json here")).toEqual([]);
    expect(parseEventsAnswer("[oops")).toEqual([]);
    expect(parseEventsAnswer('{"title":"x","start":"2026-09-30"}')).toEqual([]);
  });

  test("an end that is before the start, or of the other kind (date vs time), is left out; the event stays", () => {
    const [backwards, mixed] = parseEventsAnswer(JSON.stringify([
      { title: "Backwards", start: "2026-10-02T14:00", end: "2026-10-02T13:00" },
      { title: "Mixed", start: "2026-10-02", end: "2026-10-03T10:00" },
    ]));
    expect(backwards).toEqual({ title: "Backwards", start: "2026-10-02T14:00" });
    expect(mixed).toEqual({ title: "Mixed", start: "2026-10-02" });
  });

  test("the same event twice is one, and a runaway list is capped", () => {
    expect(parseEventsAnswer('[{"title":"A","start":"2026-09-30"},{"title":"a","start":"2026-09-30"}]')).toHaveLength(1);
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `E${i}`, start: "2026-09-30" }));
    expect(parseEventsAnswer(JSON.stringify(many))).toHaveLength(MAX_EVENTS);
  });
});

describe("buildIcs", () => {
  test("an all-day event: a DATE start and the exclusive end (the next day)", () => {
    const ics = buildIcs({ title: "Submit documents", start: "2026-09-30" }, 7, NOW)!;
    expect(line(ics, "DTSTART")).toBe("DTSTART;VALUE=DATE:20260930");
    expect(line(ics, "DTEND")).toBe("DTEND;VALUE=DATE:20261001");
    expect(buildIcs({ title: "Trip", start: "2026-12-30", end: "2027-01-02" }, 7, NOW)).toContain("DTEND;VALUE=DATE:20270103");
  });

  test("a time without a zone is floating; with a zone it is written in UTC", () => {
    expect(line(buildIcs({ title: "A", start: "2026-10-02T14:00", end: "2026-10-02T14:30" }, 1, NOW)!, "DTSTART")).toBe("DTSTART:20261002T140000");
    const ics = buildIcs({ title: "B", start: "2026-10-02T14:00+02:00", end: "2026-10-02T15:30:15-05:00" }, 1, NOW)!;
    expect(line(ics, "DTSTART")).toBe("DTSTART:20261002T120000Z");
    expect(line(ics, "DTEND")).toBe("DTEND:20261002T203015Z");
    expect(line(buildIcs({ title: "C", start: "2026-10-02T23:30+0100" }, 1, NOW)!, "DTSTART")).toBe("DTSTART:20261002T223000Z");
    expect(buildIcs({ title: "D", start: "2026-10-02T14:00" }, 1, NOW)).not.toContain("DTEND"); // none given, none invented
  });

  test("a complete, well-formed VCALENDAR: CRLF lines, required properties, escaped text", () => {
    const ics = buildIcs({ title: "Lunch; with, Bob\\Alice", start: "2026-10-02T12:00", location: "Café, Main St", description: "Line one\nLine two" }, 42, NOW)!;
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
    const lines = ics.trimEnd().split("\r\n");
    expect(lines.slice(0, 3)).toEqual(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//P.S.Mail//Events found by AI//EN"]);
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("DTSTAMP:20260901T100000Z");
    expect(lines).toContain("SUMMARY:Lunch\; with\\, Bob\\\\Alice");
    expect(lines).toContain("LOCATION:Café\\, Main St");
    expect(lines).toContain("DESCRIPTION:Line one\\nLine two");
    expect(lines.find(l => l.startsWith("UID:"))).toMatch(/^UID:psmail-42-[a-z0-9]+@psmail$/);
  });

  test("the UID is stable for the same event, and differs between events", () => {
    const uid = (title: string, start: string) => line(buildIcs({ title, start }, 5, NOW)!, "UID:");
    expect(uid("A", "2026-09-30")).toBe(uid("A", "2026-09-30"));
    expect(uid("A", "2026-09-30")).not.toBe(uid("A", "2026-10-01"));
    expect(uid("A", "2026-09-30")).not.toBe(uid("B", "2026-09-30"));
  });

  test("null when the start isn't a date", () => {
    expect(buildIcs({ title: "x", start: "soon" }, 1)).toBeNull();
  });
});

describe("line folding and escaping", () => {
  test("long lines fold at 75 octets, never inside a multi-byte character, and unfold back to the original", () => {
    const text = "DESCRIPTION:" + "Grüße ✉ ".repeat(40);
    const folded = foldIcsLine(text);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every(p => p.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(text);
    expect(foldIcsLine("SHORT:line")).toBe("SHORT:line");
  });

  test("escaping covers backslash, semicolon, comma and newline", () => {
    expect(escapeIcsText("a\\b;c,d\ne")).toBe("a\\\\b\;c\\,d\\ne");
  });
});

describe("icsFromAnswer", () => {
  test("one VCALENDAR per event found", () => {
    const list = icsFromAnswer('[{"title":"A","start":"2026-09-30"},{"title":"B","start":"2026-10-01T10:00"},{"title":"C","start":"x"}]', 3, NOW);
    expect(list).toHaveLength(2);
    expect(list.every(ics => ics.startsWith("BEGIN:VCALENDAR") && ics.includes("BEGIN:VEVENT"))).toBe(true);
    expect(icsFromAnswer("[]", 3)).toEqual([]);
  });
});
