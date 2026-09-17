import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import { createUser } from "../../src/server/models/users";
import { deriveEncryptionKey, generateSalt } from "../../src/server/crypto/secrets";
import { createAccount } from "../../src/server/models/accounts";
import {
  addAttachment,
  createEmail,
  deleteAttachment,
  deleteEmail,
  findEmailByUid,
  getAttachmentRow,
  getEmail,
  listEmails,
  moveEmail,
  updateEmail,
} from "../../src/server/models/emails";
import { ApiError } from "../../src/server/types";

function setupAccount(db: ReturnType<typeof createTestDb>) {
  return (async () => {
    const user = await createUser(db, "alice", "pw");
    const key = deriveEncryptionKey("pw", generateSalt());
    const account = createAccount(
      db,
      user.id,
      {
        email: "me@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "me@example.com",
        imapPassword: "x",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "me@example.com",
        smtpPassword: "x",
      },
      key
    );
    return account;
  })();
}

describe("emails model", () => {
  test("creates a draft with default folder/isDraft", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);

    const email = createEmail(db, account.id, {
      subject: "Hello",
      to: [{ address: "friend@example.com" }],
    });

    expect(email.folder).toBe("Drafts");
    expect(email.isDraft).toBe(true);
    expect(email.subject).toBe("Hello");
    expect(email.to).toEqual([{ address: "friend@example.com" }]);
  });

  test("stores and round-trips address lists and header fields", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);

    const email = createEmail(db, account.id, {
      folder: "INBOX",
      uid: 42,
      isDraft: false,
      from: [{ name: "Sender", address: "sender@example.com" }],
      to: [{ address: "me@example.com" }],
      cc: [{ address: "cc@example.com" }],
      received: ["from mx1 by mx2", "from mx0 by mx1"],
      dkim: "v=1; a=rsa-sha256",
      spf: "pass",
      authenticationResults: "mx.example.com; dkim=pass",
    });

    const fetched = getEmail(db, email.id);
    expect(fetched.from).toEqual([{ name: "Sender", address: "sender@example.com" }]);
    expect(fetched.received).toEqual(["from mx1 by mx2", "from mx0 by mx1"]);
    expect(fetched.dkim).toBe("v=1; a=rsa-sha256");
    expect(fetched.spf).toBe("pass");
  });

  test("findEmailByUid finds synced messages, avoiding duplicate downloads", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);
    createEmail(db, account.id, { folder: "INBOX", uid: 7, isDraft: false });

    expect(findEmailByUid(db, account.id, "INBOX", 7)).not.toBeNull();
    expect(findEmailByUid(db, account.id, "INBOX", 8)).toBeNull();
  });

  test("enforces unique (account, folder, uid)", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);
    createEmail(db, account.id, { folder: "INBOX", uid: 1, isDraft: false });
    expect(() => createEmail(db, account.id, { folder: "INBOX", uid: 1, isDraft: false })).toThrow();
  });

  test("lists emails filtered by folder, newest first", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);
    createEmail(db, account.id, { folder: "INBOX", uid: 1, isDraft: false, date: "2024-01-01T00:00:00.000Z" });
    createEmail(db, account.id, { folder: "INBOX", uid: 2, isDraft: false, date: "2024-02-01T00:00:00.000Z" });
    createEmail(db, account.id, { folder: "Drafts", isDraft: true });

    const inbox = listEmails(db, account.id, { folder: "INBOX" });
    expect(inbox).toHaveLength(2);
    expect(inbox[0]!.uid).toBe(2); // newest first
  });

  test("updateEmail merges only provided fields", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);
    const email = createEmail(db, account.id, { subject: "Original", isRead: false });

    const updated = updateEmail(db, email.id, { isRead: true });
    expect(updated.subject).toBe("Original");
    expect(updated.isRead).toBe(true);
  });

  test("moveEmail changes the folder", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);
    const email = createEmail(db, account.id, { folder: "INBOX", uid: 1, isDraft: false });

    const moved = moveEmail(db, email.id, "Archive");
    expect(moved.folder).toBe("Archive");
  });

  test("deleteEmail removes the row", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);
    const email = createEmail(db, account.id, { subject: "bye" });

    deleteEmail(db, email.id);
    expect(() => getEmail(db, email.id)).toThrow(ApiError);
  });

  test("attachments: add/get/delete cascade with the owning email", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);
    const email = createEmail(db, account.id, { subject: "with attachment" });

    const attachment = addAttachment(db, email.id, {
      filename: "invoice.pdf",
      contentType: "application/pdf",
      size: 1234,
      filePath: "/tmp/does-not-matter.pdf",
    });

    expect(getEmail(db, email.id).attachments).toHaveLength(1);
    expect(getAttachmentRow(db, attachment.id).filename).toBe("invoice.pdf");

    deleteAttachment(db, attachment.id);
    expect(getEmail(db, email.id).attachments).toHaveLength(0);
  });

  test("deleting the email cascades to its attachments", async () => {
    const db = createTestDb();
    const account = await setupAccount(db);
    const email = createEmail(db, account.id, { subject: "with attachment" });
    const attachment = addAttachment(db, email.id, {
      filename: "a.txt",
      size: 1,
      filePath: "/tmp/a.txt",
    });

    deleteEmail(db, email.id);
    expect(() => getAttachmentRow(db, attachment.id)).toThrow(ApiError);
  });
});
