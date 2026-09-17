import { describe, expect, test } from "bun:test";
import { resolveInitialView } from "../../src/components/mail/MessageBody";

describe("resolveInitialView", () => {
  test("with no remembered preference, defaults to Safe HTML when the message has HTML", () => {
    expect(resolveInitialView(null, { text: true, plain: true, html: true })).toBe("safe");
  });

  test("with no remembered preference, defaults to Plain text when there's no HTML", () => {
    expect(resolveInitialView(null, { text: true, plain: true, html: false })).toBe("plain");
  });

  test("reuses the remembered choice when it's available for this message", () => {
    expect(resolveInitialView("text", { text: true, plain: true, html: true })).toBe("text");
    expect(resolveInitialView("plain", { text: true, plain: true, html: true })).toBe("plain");
    expect(resolveInitialView("safe", { text: true, plain: true, html: true })).toBe("safe");
  });

  test("never carries Full HTML over to a new message, downgrading to Safe HTML", () => {
    expect(resolveInitialView("full", { text: true, plain: true, html: true })).toBe("safe");
  });

  test("falls back to the natural default when the remembered choice isn't available here", () => {
    // Remembered "plain", but this message has no plain-text part.
    expect(resolveInitialView("plain", { text: true, plain: false, html: true })).toBe("safe");
    // Remembered "text", but this message has neither part (shouldn't really happen, but stay safe).
    expect(resolveInitialView("text", { text: false, plain: false, html: true })).toBe("safe");
    // Remembered "full" downgrades to "safe", but even Safe HTML isn't available (no HTML at all).
    expect(resolveInitialView("full", { text: true, plain: true, html: false })).toBe("plain");
  });
});
