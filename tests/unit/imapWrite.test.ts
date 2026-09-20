import { describe, expect, test } from "bun:test";
import type { ImapFlow } from "imapflow";
import {
  appendMessage,
  createFolder,
  deleteMessage,
  fetchRemoteFlags,
  hasUidPlusCapability,
  FolderNameError,
  moveMessage,
  newFolderPath,
  runWithTeardown,
  setMessageFlags,
} from "../../src/server/services/imap";
import { canPushToImap, performDelete, wantsSoftDelete } from "../../src/server/routes/emails";
import { createEmail, getEmailRow } from "../../src/server/models/emails";
import { createAccount, type AccountRow } from "../../src/server/models/accounts";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createTestDb } from "../helpers/db";

/** A real accounts row — createEmail's account_id foreign key needs one to actually exist. */
async function setupRealAccount() {
  const db = createTestDb();
  const user = await createUser(db, "alice", "pw");
  const key = deriveEncryptionKey("pw", generateSalt());
  const account = createAccount(
    db,
    user.id,
    {
      email: "alice@example.com",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecure: true,
      imapUsername: "alice@example.com",
      imapPassword: "imap-pw",
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      smtpUsername: "alice@example.com",
      smtpPassword: "smtp-pw",
    },
    key
  );
  return { db, accountId: account.id };
}

/**
 * A fake ImapFlow client (not a mocked module — these functions take the client as a plain
 * parameter, so there's no need to touch bun:test's global module mock registry, which
 * persists across test files for the whole run and is easy to accidentally clobber; see the
 * comment in sync.test.ts for a case where that actually broke unrelated tests).
 */
function createFakeClient(
  overrides: {
    flagsAdd?: boolean;
    flagsRemove?: boolean;
    delete?: boolean;
    move?: unknown;
    append?: unknown;
    capabilities?: Map<string, boolean | number>;
    fetchResults?: { uid: number; flags: Set<string> }[];
    list?: unknown[];
  } = {}
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    capabilities: overrides.capabilities ?? new Map<string, boolean | number>(),
    list: async (...args: unknown[]) => {
      calls.push({ method: "list", args });
      return overrides.list ?? [];
    },
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
    append: async (...args: unknown[]) => {
      calls.push({ method: "append", args });
      return overrides.append ?? { destination: "Sent", uid: 7 };
    },
    fetch: (...args: unknown[]) => {
      calls.push({ method: "fetch", args });
      const results = overrides.fetchResults ?? [];
      return (async function* () {
        for (const message of results) yield message;
      })();
    },
  };
  return { client: client as unknown as ImapFlow, calls };
}

describe("runWithTeardown", () => {
  test("returns fn's result, and still runs teardown", async () => {
    let teardownRan = false;
    const result = await runWithTeardown(
      async () => "ok",
      async () => {
        teardownRan = true;
      }
    );
    expect(result).toBe("ok");
    expect(teardownRan).toBe(true);
  });

  test("a teardown failure never masks fn's successful result — the whole point of this function", async () => {
    // This is the exact bug: fn (e.g. deleteMessage, which already updated the local database
    // by the time this runs) succeeded, but the connection then failed to close cleanly. The
    // caller must still see fn's real result, not a spurious failure.
    const result = await runWithTeardown(
      async () => "ok",
      async () => {
        throw new Error("logout failed");
      }
    );
    expect(result).toBe("ok");
  });

  test("fn's own error is preserved even when teardown also fails", async () => {
    await expect(
      runWithTeardown(
        async () => {
          throw new Error("the real failure");
        },
        async () => {
          throw new Error("teardown also failed");
        }
      )
    ).rejects.toThrow("the real failure");
  });

  test("fn's error propagates normally when teardown succeeds", async () => {
    let teardownRan = false;
    await expect(
      runWithTeardown(
        async () => {
          throw new Error("boom");
        },
        async () => {
          teardownRan = true;
        }
      )
    ).rejects.toThrow("boom");
    expect(teardownRan).toBe(true);
  });
});

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

describe("hasUidPlusCapability", () => {
  test("true when the server advertises UIDPLUS", () => {
    const { client } = createFakeClient({ capabilities: new Map([["UIDPLUS", true]]) });
    expect(hasUidPlusCapability(client)).toBe(true);
  });

  test("false when it doesn't", () => {
    const { client } = createFakeClient({ capabilities: new Map([["IDLE", true]]) });
    expect(hasUidPlusCapability(client)).toBe(false);
  });
});

describe("fetchRemoteFlags", () => {
  test("opens the folder and fetches flags via one min:max UID range, not a list of every UID", async () => {
    const { client, calls } = createFakeClient({
      fetchResults: [
        { uid: 1, flags: new Set(["\\Seen"]) },
        { uid: 3, flags: new Set(["\\Seen", "\\Flagged"]) },
      ],
    });

    const result = await fetchRemoteFlags(client, "INBOX", [1, 3]);

    expect(calls).toEqual([
      { method: "mailboxOpen", args: ["INBOX"] },
      { method: "fetch", args: ["1:3", { uid: true, flags: true }, { uid: true }] },
    ]);
    expect(result).toEqual(
      new Map([
        [1, { seen: true, flagged: false }],
        [3, { seen: true, flagged: true }],
      ])
    );
  });

  test("a UID absent from the server's response is simply absent from the result", async () => {
    const { client } = createFakeClient({ fetchResults: [{ uid: 1, flags: new Set(["\\Seen"]) }] });
    const result = await fetchRemoteFlags(client, "INBOX", [1, 2]);
    expect(result.has(2)).toBe(false);
  });

  test("skips the network round-trip entirely for an empty UID list", async () => {
    const { client, calls } = createFakeClient();
    const result = await fetchRemoteFlags(client, "INBOX", []);
    expect(calls).toEqual([]);
    expect(result.size).toBe(0);
  });
});

describe("appendMessage", () => {
  test("opens the folder and appends, returning the UID the server reported", async () => {
    const { client, calls } = createFakeClient({ append: { destination: "Sent", uid: 7 } });
    const result = await appendMessage(client, "Sent", Buffer.from("raw message"), ["\\Seen"]);

    expect(calls).toEqual([{ method: "append", args: ["Sent", Buffer.from("raw message"), ["\\Seen"]] }]);
    expect(result).toEqual({ uid: 7 });
  });

  test("returns uid: null when the server didn't report one (no UIDPLUS)", async () => {
    const { client } = createFakeClient({ append: { destination: "Sent" } });
    const result = await appendMessage(client, "Sent", Buffer.from("raw message"));
    expect(result).toEqual({ uid: null });
  });

  test("throws if the append failed outright", async () => {
    const { client } = createFakeClient({ append: false });
    await expect(appendMessage(client, "Sent", Buffer.from("raw message"))).rejects.toThrow();
  });
});

describe("wantsSoftDelete", () => {
  const baseAccount = { imap_uidplus: 1, skip_soft_delete: 0 } as AccountRow;

  test("true when the server supports UIDPLUS and skipSoftDelete is off", () => {
    expect(wantsSoftDelete(baseAccount, "INBOX", "Trash")).toBe(true);
  });

  test("false when the server's UIDPLUS support is unknown (never checked)", () => {
    expect(wantsSoftDelete({ ...baseAccount, imap_uidplus: null }, "INBOX", "Trash")).toBe(false);
  });

  test("false when the server doesn't support UIDPLUS", () => {
    expect(wantsSoftDelete({ ...baseAccount, imap_uidplus: 0 }, "INBOX", "Trash")).toBe(false);
  });

  test("false when the account opted out via skipSoftDelete", () => {
    expect(wantsSoftDelete({ ...baseAccount, skip_soft_delete: 1 }, "INBOX", "Trash")).toBe(false);
  });

  test("false for a message already in Trash — no Trash-in-Trash", () => {
    expect(wantsSoftDelete(baseAccount, "Trash", "Trash")).toBe(false);
  });

  test("compares against whatever the real Trash path actually is, not a hardcoded literal", () => {
    // The account's real Trash folder is "Papierkorb" (German), not "Trash" — a message
    // already there must still be treated as "already in Trash" and not soft-deleted again.
    expect(wantsSoftDelete(baseAccount, "Papierkorb", "Papierkorb")).toBe(false);
    expect(wantsSoftDelete(baseAccount, "INBOX", "Papierkorb")).toBe(true);
  });
});

describe("performDelete", () => {
  const baseAccount = { read_only: 0, imap_uidplus: 1, skip_soft_delete: 0 } as AccountRow;

  test("soft-deletes (moves to Trash) when the server supports UIDPLUS", async () => {
    const { db, accountId } = await setupRealAccount();
    const email = createEmail(db, accountId, { folder: "INBOX", uid: 42, isDraft: false });
    const { client, calls } = createFakeClient({ move: { path: "INBOX", destination: "Trash", uidMap: new Map([[42, 99]]) } });

    const result = await performDelete(db, baseAccount, getEmailRow(db, email.id), client);

    expect(result).toEqual({ softDeleted: true });
    expect(calls.some(c => c.method === "messageMove")).toBe(true);
    expect(calls.some(c => c.method === "messageDelete")).toBe(false);
    const row = getEmailRow(db, email.id);
    expect(row.folder).toBe("Trash");
    expect(row.uid).toBe(99);
  });

  test("permanently deletes (expunges) when UIDPLUS isn't available", async () => {
    const { db, accountId } = await setupRealAccount();
    const email = createEmail(db, accountId, { folder: "INBOX", uid: 42, isDraft: false });
    const { client, calls } = createFakeClient();

    const result = await performDelete(db, { ...baseAccount, imap_uidplus: 0 }, getEmailRow(db, email.id), client);

    expect(result).toEqual({ softDeleted: false });
    expect(calls.some(c => c.method === "messageDelete")).toBe(true);
    expect(calls.some(c => c.method === "messageMove")).toBe(false);
    expect(() => getEmailRow(db, email.id)).toThrow();
  });

  test("permanently deletes when skipSoftDelete opts out, even with UIDPLUS available", async () => {
    const { db, accountId } = await setupRealAccount();
    const email = createEmail(db, accountId, { folder: "INBOX", uid: 42, isDraft: false });
    const { client, calls } = createFakeClient();

    const result = await performDelete(db, { ...baseAccount, skip_soft_delete: 1 }, getEmailRow(db, email.id), client);

    expect(result).toEqual({ softDeleted: false });
    expect(calls.some(c => c.method === "messageDelete")).toBe(true);
  });

  test("permanently deletes without touching IMAP at all for a read-only account", async () => {
    const { db, accountId } = await setupRealAccount();
    const email = createEmail(db, accountId, { folder: "INBOX", uid: 42, isDraft: false });

    const result = await performDelete(db, { ...baseAccount, read_only: 1 }, getEmailRow(db, email.id));

    expect(result).toEqual({ softDeleted: false });
    expect(() => getEmailRow(db, email.id)).toThrow();
  });

  test("soft-deletes into the server's real Trash folder even when it isn't literally named \"Trash\"", async () => {
    const { db, accountId } = await setupRealAccount();
    const email = createEmail(db, accountId, { folder: "INBOX", uid: 42, isDraft: false });
    const { client, calls } = createFakeClient({
      list: [{ path: "Papierkorb", name: "Papierkorb", delimiter: "/", specialUse: "\\Trash", flags: [] }],
      move: { path: "INBOX", destination: "Papierkorb", uidMap: new Map([[42, 99]]) },
    });

    const result = await performDelete(db, baseAccount, getEmailRow(db, email.id), client);

    expect(result).toEqual({ softDeleted: true });
    expect(calls.some(c => c.method === "messageMove" && c.args[1] === "Papierkorb")).toBe(true);
    expect(getEmailRow(db, email.id).folder).toBe("Papierkorb");
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

describe("describeImapError", () => {
  test("includes what the server said before hanging up, with a hint when it is throttling the account", async () => {
    const { describeImapError } = await import("../../src/server/services/imap");
    const closed = Object.assign(new Error("Unexpected close"), { code: "ClosedAfterConnectTLS", reason: "Account exceeded command or bandwidth limits." });
    const text = describeImapError(closed);
    expect(text).toContain("Unexpected close");
    expect(text).toContain('server said: "Account exceeded command or bandwidth limits."');
    expect(text).toContain("throttling this account");

    expect(describeImapError(Object.assign(new Error("Command failed"), { responseText: "NO nope" }))).toBe('Command failed (response="NO nope")');
    expect(describeImapError("plain")).toBe("plain");
  });
});

describe("creating folders", () => {
  const folder = (path: string, specialUse: string | null = null, delimiter = "/") => ({ path, name: path.split(delimiter).pop()!, delimiter, specialUse, flags: [] as string[] });
  const existing = [folder("INBOX", "\\Inbox"), folder("Sent", "\\Sent"), folder("Work")];

  test("a top-level folder is just its name; a nested one is parent + delimiter + name", () => {
    expect(newFolderPath(existing, "Receipts", null)).toBe("Receipts");
    expect(newFolderPath(existing, "  Receipts  ", null)).toBe("Receipts");
    expect(newFolderPath(existing, "2024", "Work")).toBe("Work/2024");
    expect(newFolderPath([folder("INBOX", "\\Inbox", "."), folder("Work", null, ".")], "2024", "Work")).toBe("Work.2024");
  });

  test("servers that keep everything under INBOX. get top-level folders there too", () => {
    const namespaced = [folder("INBOX", "\\Inbox", "."), folder("INBOX.Sent", "\\Sent", "."), folder("INBOX.Work", null, ".")];
    expect(newFolderPath(namespaced, "Receipts", null)).toBe("INBOX.Receipts");
  });

  test("bad names are refused before anything is sent", () => {
    for (const name of ["", "   ", "a/b", "a*", "a%", "..", "tab\tname", "x".repeat(101)]) {
      expect(() => newFolderPath(existing, name, null)).toThrow(FolderNameError);
    }
  });

  test("an existing folder (any case) and a missing parent are refused, with a reason that says which", () => {
    expect(() => newFolderPath(existing, "work", null)).toThrow(expect.objectContaining({ kind: "exists" }));
    expect(() => newFolderPath(existing, "x", "Nope")).toThrow(expect.objectContaining({ kind: "missing-parent" }));
  });

  test("createFolder creates and subscribes, and returns the server's list afterwards", async () => {
    const calls: string[] = [];
    let listed = existing;
    const client = {
      list: async () => listed,
      mailboxCreate: async (p: string) => {
        calls.push(`create ${p}`);
        listed = [...existing, folder(p)];
      },
      mailboxSubscribe: async (p: string) => {
        calls.push(`subscribe ${p}`);
      },
    } as unknown as ImapFlow;

    const result = await createFolder(client, "2024", "Work");
    expect(calls).toEqual(["create Work/2024", "subscribe Work/2024"]);
    expect(result.path).toBe("Work/2024");
    expect(result.folders.map(f => f.path)).toContain("Work/2024");
  });

  test("a server without subscriptions still counts as created, and a refusal by the server is passed on", async () => {
    const base = { list: async () => existing };
    const created = await createFolder({ ...base, mailboxCreate: async () => {}, mailboxSubscribe: async () => Promise.reject(new Error("no")) } as unknown as ImapFlow, "A", null);
    expect(created.path).toBe("A");

    const refusing = { ...base, mailboxCreate: async () => Promise.reject(new Error("NO [NOPERM]")) } as unknown as ImapFlow;
    await expect(createFolder(refusing, "B", null)).rejects.toThrow("NOPERM");
  });
});
