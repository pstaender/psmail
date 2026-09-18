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
