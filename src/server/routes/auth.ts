import type { Database } from "bun:sqlite";
import { deriveEncryptionKey } from "../crypto/secrets";
import { json, readJsonBody, requireAuth, withErrorHandling } from "../http";
import { verifyUserPassword } from "../models/users";
import { createSession, destroySession } from "../services/sessions";

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
    "/api/auth/logout": {
      POST: withErrorHandling(async req => {
        const { session } = requireAuth(req, db);
        destroySession(db, session.token);
        return json({ ok: true });
      }),
    },
  };
}
