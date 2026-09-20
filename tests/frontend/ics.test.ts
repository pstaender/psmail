import { describe, expect, test } from "bun:test";
import { describeIcs, icsFileName, mergeIcs } from "../../src/lib/ics";

const wrap = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n") + "\r\n";

describe("describeIcs", () => {
  test("title, place and start of an all-day event, with escaped text unescaped", () => {
    const info = describeIcs(wrap("DTSTART;VALUE=DATE:20260930", "SUMMARY:Lunch\; with\\, Bob", "LOCATION:Café\\nMain St"));
    expect(info).toMatchObject({ title: "Lunch; with, Bob", allDay: true, location: "Café\nMain St" });
    expect(info.start).toEqual(new Date(2026, 8, 30));
  });

  test("a floating time is local, a Z time is UTC, folded lines are joined", () => {
    expect(describeIcs(wrap("DTSTART:20261002T140000", "SUMMARY:A")).start).toEqual(new Date(2026, 9, 2, 14, 0, 0));
    expect(describeIcs(wrap("DTSTART:20261002T120000Z", "SUMMARY:A")).start).toEqual(new Date(Date.UTC(2026, 9, 2, 12)));
    expect(describeIcs(wrap("DTSTART:20261002T140000", "SUMMARY:A very long", " title continued")).title).toBe("A very longtitle continued");
  });

  test("odd input doesn't throw", () => {
    expect(describeIcs("")).toEqual({ title: "(untitled)", start: null, allDay: false, location: null });
    expect(describeIcs(wrap("DTSTART:garbage", "SUMMARY:x")).start).toBeNull();
  });
});

describe("icsFileName and mergeIcs", () => {
  test("file names are safe and never empty", () => {
    expect(icsFileName("Call: Alice/Bob?")).toBe("Call_ Alice_Bob_.ics");
    expect(icsFileName("   ")).toBe("event.ics");
    expect(icsFileName("x".repeat(200)).length).toBeLessThan(90);
  });

  test("merging puts every VEVENT into one VCALENDAR; one text stays as it is", () => {
    const a = wrap("UID:a", "SUMMARY:A");
    const b = wrap("UID:b", "SUMMARY:B");
    expect(mergeIcs([a])).toBe(a);
    const merged = mergeIcs([a, b]);
    expect(merged.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
    expect(merged.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(merged.indexOf("UID:a")).toBeLessThan(merged.indexOf("UID:b"));
    expect(merged.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
