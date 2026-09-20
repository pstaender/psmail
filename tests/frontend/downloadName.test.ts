import { describe, expect, test } from "bun:test";
import { filenameFromDisposition } from "../../src/lib/api";

describe("filenameFromDisposition", () => {
  test("prefers the UTF-8 name over the ASCII fallback", () => {
    expect(filenameFromDisposition(`attachment; filename="Gr__e.eml"; filename*=UTF-8''Gr%C3%BC%C3%9Fe.eml`)).toBe("Grüße.eml");
  });
  test("falls back to the plain name, and to null", () => {
    expect(filenameFromDisposition(`attachment; filename="a b.zip"`)).toBe("a b.zip");
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A; filename="x.zip"`)).toBe("x.zip"); // broken escape
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition("inline")).toBeNull();
  });
});
