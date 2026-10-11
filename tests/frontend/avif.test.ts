import { describe, expect, test } from "bun:test";
import { avifFileName, canOfferAvif, JPEG_THRESHOLD_BYTES } from "../../src/lib/avif";

const fileOf = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type });

describe("canOfferAvif", () => {
  test("offers every PNG", () => {
    expect(canOfferAvif(fileOf("a.png", "image/png", 10))).toBe(true);
  });

  test("offers JPEGs only above the threshold", () => {
    expect(canOfferAvif(fileOf("a.jpg", "image/jpeg", JPEG_THRESHOLD_BYTES))).toBe(false);
    expect(canOfferAvif(fileOf("a.jpg", "image/jpeg", JPEG_THRESHOLD_BYTES + 1))).toBe(true);
  });

  test("doesn't offer other files", () => {
    expect(canOfferAvif(fileOf("a.webp", "image/webp", 500_000))).toBe(false);
    expect(canOfferAvif(fileOf("a.avif", "image/avif", 500_000))).toBe(false);
    expect(canOfferAvif(fileOf("a.pdf", "application/pdf", 500_000))).toBe(false);
  });
});

describe("avifFileName", () => {
  test("replaces the extension", () => {
    expect(avifFileName("photo.final.PNG")).toBe("photo.final.avif");
    expect(avifFileName("scan.jpeg")).toBe("scan.avif");
  });

  test("adds one when there is none", () => {
    expect(avifFileName("screenshot")).toBe("screenshot.avif");
    expect(avifFileName(".hidden")).toBe(".hidden.avif");
  });
});
