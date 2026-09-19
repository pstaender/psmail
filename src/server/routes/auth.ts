import type { Database } from "bun:sqlite";
import { deriveEncryptionKey } from "../crypto/secrets";
import { json, readJsonBody, requireAuth, withErrorHandling } from "../http";
import { verifyUserPassword } from "../models/users";
import { changePasswordForSession } from "../services/passwordChange";
import { createSession, destroySession } from "../services/sessions";
import { ApiError } from "../types";

interface LoginBody {
  username: string;
  password: string;
}

export function authRoutes(db: Database) {
  return {
    "/api/auth/login": {
      POST: withErrorHandling(async req => {
        const body = await readJsonBody<LoginBody>(req);
        const userRow = await verifyUserPassword(db, body.username, body.password ?? "");

        const encryptionKey = deriveEncryptionKey(body.password ?? "", userRow.password_salt);
        const session = await createSession(db, userRow.id, encryptionKey);

        return json({
          token: session.token,
          expiresAt: session.expiresAt,
          user: { id: userRow.id, username: userRow.username },
        });
      }),
    },
    /** Changes the signed-in user's password; needs the current one. Re-encrypts their accounts' saved passwords and signs out their other sessions. */
    "/api/auth/change-password": {
      POST: withErrorHandling(async req => {
        const { session, encryptionKey } = requireAuth(req, db);
        const body = await readJsonBody<{ currentPassword?: unknown; newPassword?: unknown }>(req);
        if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
          throw new ApiError(400, "currentPassword and newPassword are required");
        }
        const result = await changePasswordForSession(db, session, encryptionKey, body.currentPassword, body.newPassword);
        return json({ ok: true, ...result });
      }),
    },
    "/api/auth/logout": {
      POST: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        destroySession(db, session.token);
        return json({ ok: true });
      }),
    },
  };
}
