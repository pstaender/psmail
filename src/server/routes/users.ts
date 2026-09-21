import type { Database } from "bun:sqlite";
import { json, parseIntParam, readJsonBody, requireAuth, withErrorHandling } from "../http";
import { createUser, deleteUser, getUser, listUsers } from "../models/users";
import { changePasswordForSession } from "../services/passwordChange";
import { ApiError } from "../types";

interface CreateUserBody {
  username: string;
  password?: string;
}

interface UpdateUserBody {
  password: string;
  /** The current password — needed because changing it re-encrypts the user's saved account passwords. */
  currentPassword: string;
}

export function usersRoutes(db: Database) {
  return {
    "/api/users": {
      GET: withErrorHandling(async () => json(listUsers(db))),
      POST: withErrorHandling(async req => {
        const body = await readJsonBody<CreateUserBody>(req);
        if (!body.username || !body.username.trim()) throw new ApiError(400, "username is required");
        const user = await createUser(db, body.username.trim(), body.password ?? "");
        return json(user, { status: 201 });
      }),
    },
    /**
     * Which profiles have an account with this address: `GET /api/account-owners?email=a@b.example` -> `[{ username }]`. For the CLI,
     * to tell which `--user` to use — profile names are listed for everybody here already (the sign-in screen), nothing else is given away.
     */
    "/api/account-owners": {
      GET: withErrorHandling(async req => {
        const email = new URL(req.url).searchParams.get("email")?.trim();
        if (!email) throw new ApiError(400, "email is required");
        return json(
          db
            .query<{ username: string }, [string]>(
              "SELECT users.username FROM accounts JOIN users ON users.id = accounts.user_id WHERE lower(accounts.email) = lower(?) ORDER BY users.id"
            )
            .all(email)
        );
      }),
    },
    "/api/users/:id": {
      GET: withErrorHandling(async req => {
        const id = parseIntParam(req.params.id, "id");
        return json(getUser(db, id));
      }),
      PATCH: withErrorHandling(async req => {
        const id = parseIntParam(req.params.id, "id");
        const { session, encryptionKey } = requireAuth(req, db);
        if (session.userId !== id) throw new ApiError(403, "Cannot modify another user");

        const body = await readJsonBody<UpdateUserBody>(req);
        if (typeof body.password !== "string") throw new ApiError(400, "password is required");
        if (typeof body.currentPassword !== "string") throw new ApiError(400, "currentPassword is required");
        await changePasswordForSession(db, session, encryptionKey, body.currentPassword, body.password);
        return json(getUser(db, id));
      }),
      DELETE: withErrorHandling(async req => {
        const id = parseIntParam(req.params.id, "id");
        const { session } = requireAuth(req, db);
        if (session.userId !== id) throw new ApiError(403, "Cannot delete another user");

        deleteUser(db, id);
        return new Response(null, { status: 204 });
      }),
    },
  };
}
