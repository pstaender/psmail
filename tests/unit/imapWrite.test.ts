import { describe, expect, test } from "bun:test";
import type { ImapFlow } from "imapflow";
import {
  appendMessage,
  deleteMessage,
  fetchRemoteFlags,
  hasUidPlusCapability,
  moveMessage,
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
  } = {}
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    capabilities: overrides.capabilities ?? new Map<string, boolean | number>(),
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
  test("opens the folder and fetches flags for exactly the given UIDs", async () => {
    const { client, calls } = createFakeClient({
      fetchResults: [
        { uid: 1, flags: new Set(["\\Seen"]) },
        { uid: 3, flags: new Set(["\\Seen", "\\Flagged"]) },
      ],
    });

    const result = await fetchRemoteFlags(client, "INBOX", [1, 3]);

    expect(calls).toEqual([
      { method: "mailboxOpen", args: ["INBOX"] },
      { method: "fetch", args: [{ uid: "1,3" }, { uid: true, flags: true }] },
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
    expect(wantsSoftDelete(baseAccount, "INBOX")).toBe(true);
  });

  test("false when the server's UIDPLUS support is unknown (never checked)", () => {
    expect(wantsSoftDelete({ ...baseAccount, imap_uidplus: null }, "INBOX")).toBe(false);
  });

  test("false when the server doesn't support UIDPLUS", () => {
    expect(wantsSoftDelete({ ...baseAccount, imap_uidplus: 0 }, "INBOX")).toBe(false);
  });

  test("false when the account opted out via skipSoftDelete", () => {
    expect(wantsSoftDelete({ ...baseAccount, skip_soft_delete: 1 }, "INBOX")).toBe(false);
  });

  test("false for a message already in Trash — no Trash-in-Trash", () => {
    expect(wantsSoftDelete(baseAccount, "Trash")).toBe(false);
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
