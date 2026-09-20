import { describe, expect, test } from "bun:test";
import { boundsOf, describeFilter, validateFilter } from "../../src/lib/dateFilter";

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

describe("boundsOf", () => {
  test("a day runs from its own midnight to the next one, in the local time zone", () => {
    expect(boundsOf({ mode: "day", day: "2026-03-02" })).toEqual({ after: local(2026, 3, 2), before: local(2026, 3, 3) });
  });

  test("a range includes its last day; since is inclusive, before is exclusive", () => {
    expect(boundsOf({ mode: "range", from: "2026-03-02", to: "2026-03-04" })).toEqual({ after: local(2026, 3, 2), before: local(2026, 3, 5) });
    expect(boundsOf({ mode: "since", day: "2026-03-02" })).toEqual({ after: local(2026, 3, 2) });
    expect(boundsOf({ mode: "before", day: "2026-03-02" })).toEqual({ before: local(2026, 3, 2) });
  });

  test("month and year ends, leap days, and days that are 23 or 25 hours long don't break it", () => {
    expect(boundsOf({ mode: "day", day: "2026-12-31" })).toEqual({ after: local(2026, 12, 31), before: local(2027, 1, 1) });
    expect(boundsOf({ mode: "day", day: "2028-02-29" })).toEqual({ after: local(2028, 2, 29), before: local(2028, 3, 1) });
    for (const day of ["2026-03-29", "2026-10-25", "2026-03-08", "2026-11-01"]) {
      const { after, before } = boundsOf({ mode: "day", day });
      expect(new Date(before!).getTime()).toBeGreaterThan(new Date(after!).getTime());
    }
  });

  test("no filter, no window", () => {
    expect(boundsOf(null)).toEqual({});
  });
});

describe("validateFilter and describeFilter", () => {
  test("only real dates, and a range that doesn't end before it starts", () => {
    expect(validateFilter({ mode: "day", day: "2026-03-02" })).toBeNull();
    expect(validateFilter({ mode: "day", day: "" })).toBe("Pick a date.");
    expect(validateFilter({ mode: "since", day: "2026-02-30" })).toBe("Pick a date.");
    expect(validateFilter({ mode: "range", from: "2026-03-02", to: "2026-03-02" })).toBeNull();
    expect(validateFilter({ mode: "range", from: "2026-03-05", to: "2026-03-02" })).toBe("The range ends before it starts.");
    expect(validateFilter({ mode: "range", from: "2026-03-05", to: "" })).toBe("Pick a date.");
  });

  test("the chip text", () => {
    expect(describeFilter({ mode: "since", day: "2026-03-02" })).toMatch(/^since .*2026/);
    expect(describeFilter({ mode: "before", day: "2026-03-02" })).toMatch(/^before .*2026/);
    expect(describeFilter({ mode: "range", from: "2026-03-02", to: "2026-03-04" })).toContain(" – ");
    expect(describeFilter({ mode: "range", from: "2026-03-02", to: "2026-03-02" })).not.toContain(" – ");
  });
});
