import { describe, expect, test } from "bun:test";
import { resolveSpecialFolder, type SpecialUseFolder } from "../../src/lib/folders";

function folder(path: string, specialUse: string | null): SpecialUseFolder {
  return { path, specialUse };
}

describe("resolveSpecialFolder", () => {
  test("picks the folder matching the special-use flag, whatever its literal name", () => {
    // A server naming its Drafts folder in German rather than English is exactly the case
    // this exists for.
    const folders = [folder("INBOX", "\\Inbox"), folder("Entwürfe", "\\Drafts")];
    expect(resolveSpecialFolder(folders, "\\Drafts", "Drafts")).toBe("Entwürfe");
  });

  test("falls back to the literal fallback path when no folder has that special-use flag", () => {
    const folders = [folder("INBOX", "\\Inbox")];
    expect(resolveSpecialFolder(folders, "\\Drafts", "Drafts")).toBe("Drafts");
  });

  test("falls back when the folder list is empty (e.g. not loaded yet)", () => {
    expect(resolveSpecialFolder([], "\\Drafts", "Drafts")).toBe("Drafts");
  });
});
