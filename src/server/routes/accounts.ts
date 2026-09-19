import type { Database } from "bun:sqlite";
import {
  assertAccountEnabled,
  createAccount,
  decryptAccountCredentials,
  deleteAccount,
  getAccount,
  getAccountByEmail,
  listAccounts,
  setImapUidPlus,
  updateAccount,
  type AccountRow,
  type CreateAccountInput,
  type UpdateAccountInput,
} from "../models/accounts";
import { json, readJsonBody, requireAuth, requiredParam, withErrorHandling } from "../http";
import { checkImapCapabilities } from "../services/imap";
import { ApiError } from "../types";

/** Accounts are addressed in the URL by their email address (e.g. /api/accounts/me%40example.com). */
export function getOwnedAccountByEmailParam(db: Database, emailParam: string | undefined, userId: number): AccountRow {
  return getAccountByEmail(db, userId, decodeURIComponent(requiredParam(emailParam, "email")));
}

function validateCreateInput(body: Partial<CreateAccountInput>): CreateAccountInput {
  const required: (keyof CreateAccountInput)[] = [
    "email",
    "imapHost",
    "imapPort",
    "imapUsername",
    "imapPassword",
    "smtpHost",
    "smtpPort",
    "smtpUsername",
    "smtpPassword",
  ];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw new ApiError(400, `${field} is required`);
    }
  }
  return {
    email: body.email!,
    displayName: body.displayName,
    imapHost: body.imapHost!,
    imapPort: body.imapPort!,
    imapSecure: body.imapSecure ?? true,
    imapUsername: body.imapUsername!,
    imapPassword: body.imapPassword!,
    smtpHost: body.smtpHost!,
    smtpPort: body.smtpPort!,
    smtpSecure: body.smtpSecure ?? true,
    smtpUsername: body.smtpUsername!,
    smtpPassword: body.smtpPassword!,
    readOnly: body.readOnly ?? false,
    skipSoftDelete: body.skipSoftDelete ?? false,
    senderName: body.senderName,
    signature: body.signature,
  };
}

export function accountsRoutes(db: Database) {
  return {
    "/api/accounts": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        return json(listAccounts(db, session.userId));
      }),
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const body = await readJsonBody<Partial<CreateAccountInput>>(req);
        const input = validateCreateInput(body);
        const account = createAccount(db, session.userId, input, encryptionKey);
        return json(account, { status: 201 });
      }),
    },
    "/api/accounts/:email": {
      GET: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const row = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        return json(getAccount(db, row.id));
      }),
      PATCH: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const row = getOwnedAccountByEmailParam(db, req.params.email, session.userId);

        const body = await readJsonBody<UpdateAccountInput>(req);
        if (body.position !== undefined && !Number.isFinite(body.position)) throw new ApiError(400, "position must be a number");
        const account = updateAccount(db, row.id, body, encryptionKey);
        return json(account);
      }),
      DELETE: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        const row = getOwnedAccountByEmailParam(db, req.params.email, session.userId);

        deleteAccount(db, row.id);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/accounts/:email/imap-capabilities": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const row = getOwnedAccountByEmailParam(db, req.params.email, session.userId);
        assertAccountEnabled(row); // no connection to a disabled account

        const { imapPassword } = decryptAccountCredentials(row, encryptionKey);
        const { uidPlus } = await checkImapCapabilities({
          host: row.imap_host,
          port: row.imap_port,
          secure: !!row.imap_secure,
          username: row.imap_username,
          password: imapPassword,
        });

        return json(setImapUidPlus(db, row.id, uidPlus));
      }),
    },
  };
}
