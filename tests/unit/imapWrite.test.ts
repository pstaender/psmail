import { describe, expect, test } from "bun:test";
import type { ImapFlow } from "imapflow";
import { deleteMessage, moveMessage, setMessageFlags } from "../../src/server/services/imap";
import { canPushToImap } from "../../src/server/routes/emails";
import type { AccountRow } from "../../src/server/models/accounts";

/**
 * A fake ImapFlow client (not a mocked module — these functions take the client as a plain
 * parameter, so there's no need to touch bun:test's global module mock registry, which
 * persists across test files for the whole run and is easy to accidentally clobber; see the
 * comment in sync.test.ts for a case where that actually broke unrelated tests).
 */
function createFakeClient(overrides: { flagsAdd?: boolean; flagsRemove?: boolean; delete?: boolean; move?: unknown } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    mailboxOpen: async (...args: unknown[]) => {
      calls.push({ method: "mailboxOpen", args });
      return {};
    },
    messageFlagsAdd: async (...args: unknown[]) => {
      calls.push({ method: "messageFlagsAdd", args });
      return overrides.flagsAdd ?? true;
    },
    messageFlagsRemove: async (...args: unknown[]) => {
      calls.push({ method: "messageFlagsRemove", args });
      return overrides.flagsRemove ?? true;
    },
    messageDelete: async (...args: unknown[]) => {
      calls.push({ method: "messageDelete", args });
      return overrides.delete ?? true;
    },
    messageMove: async (...args: unknown[]) => {
      calls.push({ method: "messageMove", args });
      return overrides.move ?? { path: "INBOX", destination: "Archive", uidMap: new Map([[42, 99]]) };
    },
  };
  return { client: client as unknown as ImapFlow, calls };
}

describe("setMessageFlags", () => {
  test("opens the folder, then adds \\Seen when marking read", async () => {
    const { client, calls } = createFakeClient();
    await setMessageFlags(client, "INBOX", 42, { seen: true });

    expect(calls).toEqual([
      { method: "mailboxOpen", args: ["INBOX"] },
      { method: "messageFlagsAdd", args: [[42], ["\\Seen"], { uid: true }] },
    ]);
  });

  test("removes \\Seen when marking unread", async () => {
    const { client, calls } = createFakeClient();
    await setMessageFlags(client, "INBOX", 42, { seen: false });

    expect(calls).toEqual([
      { method: "mailboxOpen", args: ["INBOX"] },
      { method: "messageFlagsRemove", args: [[42], ["\\Seen"], { uid: true }] },
    ]);
  });

  test("combines \\Seen and \\Flagged into a single add call when both are being set", async () => {
    const { client, calls } = createFakeClient();
    await setMessageFlags(client, "INBOX", 42, { seen: true, flagged: true });

    expect(calls.filter(c => c.method === "messageFlagsAdd")).toEqual([
      { method: "messageFlagsAdd", args: [[42], ["\\Seen", "\\Flagged"], { uid: true }] },
    ]);
  });

  test("can add one flag and remove the other in the same call", async () => {
    const { client, calls } = createFakeClient();
    await setMessageFlags(client, "INBOX", 42, { seen: true, flagged: false });

    expect(calls.filter(c => c.method !== "mailboxOpen")).toEqual([
      { method: "messageFlagsAdd", args: [[42], ["\\Seen"], { uid: true }] },
      { method: "messageFlagsRemove", args: [[42], ["\\Flagged"], { uid: true }] },
    ]);
  });

  test("throws if the server reports the flag change failed", async () => {
    const { client } = createFakeClient({ flagsAdd: false });
    await expect(setMessageFlags(client, "INBOX", 42, { seen: true })).rejects.toThrow();
  });

  test("does nothing when no flags are given", async () => {
    const { client, calls } = createFakeClient();
    await setMessageFlags(client, "INBOX", 42, {});
    expect(calls).toEqual([{ method: "mailboxOpen", args: ["INBOX"] }]);
  });
});

describe("deleteMessage", () => {
  test("opens the folder then deletes by UID", async () => {
    const { client, calls } = createFakeClient();
    await deleteMessage(client, "INBOX", 42);

    expect(calls).toEqual([
      { method: "mailboxOpen", args: ["INBOX"] },
      { method: "messageDelete", args: [[42], { uid: true }] },
    ]);
  });

  test("throws if the server reports the delete failed", async () => {
    const { client } = createFakeClient({ delete: false });
    await expect(deleteMessage(client, "INBOX", 42)).rejects.toThrow();
  });
});

describe("moveMessage", () => {
  test("opens the folder, moves by UID, and returns the new UID from the server's uidMap", async () => {
    const { client, calls } = createFakeClient();
    const result = await moveMessage(client, "INBOX", 42, "Archive");

    expect(calls).toEqual([
      { method: "mailboxOpen", args: ["INBOX"] },
      { method: "messageMove", args: [[42], "Archive", { uid: true }] },
    ]);
    expect(result).toEqual({ newUid: 99 });
  });

  test("returns newUid: null when the server didn't report a uidMap (no UIDPLUS)", async () => {
    const { client } = createFakeClient({ move: { path: "INBOX", destination: "Archive" } });
    const result = await moveMessage(client, "INBOX", 42, "Archive");
    expect(result).toEqual({ newUid: null });
  });

  test("throws if the move failed outright", async () => {
    const { client } = createFakeClient({ move: false });
    await expect(moveMessage(client, "INBOX", 42, "Archive")).rejects.toThrow();
  });
});

describe("canPushToImap", () => {
  const baseAccount = { read_only: 0 } as AccountRow;

  test("true for a synced message on a non-read-only account", () => {
    expect(canPushToImap(baseAccount, 42)).toBe(true);
  });

  test("false when the account is read-only", () => {
    expect(canPushToImap({ ...baseAccount, read_only: 1 }, 42)).toBe(false);
  });

  test("false for a message with no UID (a draft, or something sent but never appended to IMAP)", () => {
    expect(canPushToImap(baseAccount, null)).toBe(false);
  });
});
