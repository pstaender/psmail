import { describe, expect, test } from "bun:test";
import { formatListDate } from "../../src/lib/time";

const DAY_MS = 24 * 60 * 60 * 1000;
/** An ISO instant `daysAgo` calendar days before now, at a fixed time of day (safely inside "today" regardless of when the test runs). */
function daysAgo(n: number): string {
  const date = new Date();
  date.setHours(10, 30, 0, 0);
  date.setDate(date.getDate() - n);
  return date.toISOString();
}

describe("formatListDate", () => {
  test("empty/invalid input: an empty string, never a crash", () => {
    expect(formatListDate(null)).toBe("");
    expect(formatListDate("not a date")).toBe("");
  });

  test("today: the time", () => {
    const today = new Date();
    today.setHours(14, 5, 0, 0);
    expect(formatListDate(today.toISOString())).toMatch(/\d{1,2}:\d{2}/);
    expect(formatListDate(today.toISOString())).not.toContain("Yesterday");
  });

  test("yesterday: the word \"Yesterday\"", () => {
    expect(formatListDate(daysAgo(1))).toBe("Yesterday");
  });

  test("2 to 6 days ago: the weekday name, not a date", () => {
    const now = new Date();
    for (let n = 2; n <= 6; n++) {
      const reference = new Date(now);
      reference.setDate(now.getDate() - n);
      const expectedWeekday = reference.toLocaleDateString(undefined, { weekday: "long" });
      expect(formatListDate(daysAgo(n))).toBe(expectedWeekday);
    }
  });

  test("7+ days ago: a short date, not a weekday", () => {
    const result = formatListDate(daysAgo(7));
    const now = new Date();
    for (let n = 0; n <= 6; n++) {
      const reference = new Date(now);
      reference.setDate(now.getDate() - n);
      expect(result).not.toBe(reference.toLocaleDateString(undefined, { weekday: "long" }));
    }
    expect(result).not.toBe("Yesterday");
  });

  test("a date from a previous year includes the year; this year doesn't", () => {
    const now = new Date();
    const lastYear = new Date(now.getFullYear() - 1, 5, 15);
    expect(formatListDate(lastYear.toISOString())).toContain(String(now.getFullYear() - 1));

    // Something safely more than 6 days in the past but still this year (skip near year-start, where that's not possible).
    if (now.getMonth() > 0 || now.getDate() > 10) {
      const earlierThisYear = new Date(now.getFullYear(), 0, 2);
      if (now.getTime() - earlierThisYear.getTime() > 6 * DAY_MS) {
        expect(formatListDate(earlierThisYear.toISOString())).not.toContain(String(now.getFullYear()));
      }
    }
  });

  test("forceDate: today, yesterday and the weekday window all become a plain date instead", () => {
    const now = new Date();
    expect(formatListDate(now.toISOString(), { forceDate: true })).not.toMatch(/\d{1,2}:\d{2}/);
    expect(formatListDate(daysAgo(1), { forceDate: true })).not.toBe("Yesterday");

    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(now.getDate() - 2);
    const weekday = twoDaysAgo.toLocaleDateString(undefined, { weekday: "long" });
    expect(formatListDate(daysAgo(2), { forceDate: true })).not.toBe(weekday);

    // Exactly the same short-date format the normal 7+ days fallback already produces.
    const expected = twoDaysAgo.toLocaleDateString(undefined, twoDaysAgo.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
    expect(formatListDate(daysAgo(2), { forceDate: true })).toBe(expected);
  });
});
