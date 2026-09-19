import { describe, expect, test } from "bun:test";
import { mergeFolderCounts } from "../../src/server/routes/folders";
import type { ImapFolder } from "../../src/server/services/imap";
import type { FolderCount } from "../../src/server/models/emails";

function folder(path: string, specialUse: string | null = null): ImapFolder {
  return { path, name: path, delimiter: "/", specialUse, flags: [] };
}

describe("mergeFolderCounts", () => {
  test("merges local counts into matching live folders", () => {
    const result = mergeFolderCounts(
      [folder("INBOX", "\\Inbox"), folder("Archive")],
      [{ folder: "INBOX", total: 5, unread: 2 }]
    );
    expect(result).toEqual([
      { ...folder("INBOX", "\\Inbox"), total: 5, unread: 2 },
      { ...folder("Archive"), total: 0, unread: 0 },
    ]);
  });

  test("adds a synthetic entry for a folder that only exists locally", () => {
    // The account has no server-side "Drafts" folder at all (a minimal/fresh IMAP account),
    // but a draft was still created locally — it must stay reachable.
    const result = mergeFolderCounts([folder("INBOX", "\\Inbox")], [{ folder: "Drafts", total: 3, unread: 0 }]);

    expect(result).toEqual([
      { ...folder("INBOX", "\\Inbox"), total: 0, unread: 0 },
      { path: "Drafts", name: "Drafts", delimiter: "/", specialUse: "\\Drafts", flags: [], total: 3, unread: 0 },
    ]);
  });

  test("guesses specialUse for Sent/Trash synthetic entries too, but not for an arbitrary local-only folder name", () => {
    const result = mergeFolderCounts(
      [],
      [
        { folder: "Sent", total: 1, unread: 0 },
        { folder: "Trash", total: 1, unread: 0 },
        { folder: "Somewhere else", total: 1, unread: 0 },
      ]
    );

    expect(result.find(f => f.path === "Sent")?.specialUse).toBe("\\Sent");
    expect(result.find(f => f.path === "Trash")?.specialUse).toBe("\\Trash");
    expect(result.find(f => f.path === "Somewhere else")?.specialUse).toBeNull();
  });

  test("does not duplicate a folder that exists both live and locally under the same path", () => {
    const result = mergeFolderCounts([folder("Drafts", "\\Drafts")], [{ folder: "Drafts", total: 2, unread: 1 }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ ...folder("Drafts", "\\Drafts"), total: 2, unread: 1 });
  });

  test("empty local counts leave live folders untouched at zero", () => {
    const result = mergeFolderCounts([folder("INBOX", "\\Inbox")], []);
    expect(result).toEqual([{ ...folder("INBOX", "\\Inbox"), total: 0, unread: 0 }]);
  });
});

describe("special-use fallback by name, and the Inbox first", () => {
  test("without an \\Inbox / \\Sent flag, a folder named inbox / sent (any case) is taken for it", async () => {
    const { applySpecialUseFallback } = await import("../../src/server/services/imap");
    const result = applySpecialUseFallback([folder("Archive"), folder("Inbox"), folder("SENT"), folder("Drafts", "\\Drafts")]);
    expect(result.map(f => [f.path, f.specialUse])).toEqual([["Archive", null], ["Inbox", "\\Inbox"], ["SENT", "\\Sent"], ["Drafts", "\\Drafts"]]);
  });

  test("a real flag wins: when some folder carries it, name lookalikes stay unflagged", async () => {
    const { applySpecialUseFallback } = await import("../../src/server/services/imap");
    const result = applySpecialUseFallback([folder("Sent Items", "\\Sent"), folder("Sent"), folder("INBOX", "\\Inbox"), folder("Inbox")]);
    expect(result.map(f => f.specialUse)).toEqual(["\\Sent", null, "\\Inbox", null]);
  });

  test("uses the folder's own name, so INBOX.Sent-style paths work; other names aren't touched", async () => {
    const { applySpecialUseFallback } = await import("../../src/server/services/imap");
    const nested: ImapFolder = { path: "INBOX.Sent", name: "Sent", delimiter: ".", specialUse: null, flags: [] };
    expect(applySpecialUseFallback([nested, folder("Sent Messages"), folder("Inbox2")]).map(f => f.specialUse)).toEqual(["\\Sent", null, null]);
  });

  test("mergeFolderCounts puts the Inbox first, whatever the server's order, and applies the fallback to remembered lists too", () => {
    const result = mergeFolderCounts([folder("Archive"), folder("Sent"), folder("inbox"), folder("Zeta")], [{ folder: "inbox", total: 4, unread: 1 }]);
    expect(result.map(f => f.path)).toEqual(["inbox", "Archive", "Sent", "Zeta"]);
    expect(result.map(f => f.specialUse)).toEqual(["\\Inbox", null, "\\Sent", null]);
    expect(result[0]).toMatchObject({ total: 4, unread: 1 });
  });

  test("folders that exist only locally are recognized case-insensitively too, and the Inbox is still first", () => {
    const result = mergeFolderCounts([], [
      { folder: "Archive", total: 1, unread: 0 },
      { folder: "sent", total: 2, unread: 0 },
      { folder: "drafts", total: 1, unread: 0 },
      { folder: "Inbox", total: 5, unread: 3 },
    ]);
    expect(result.map(f => [f.path, f.specialUse])).toEqual([["Inbox", "\\Inbox"], ["Archive", null], ["sent", "\\Sent"], ["drafts", "\\Drafts"]]);
  });
});
