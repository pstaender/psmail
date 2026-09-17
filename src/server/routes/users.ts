import type { Database } from "bun:sqlite";
import { json, parseIntParam, readJsonBody, requireAuth, withErrorHandling } from "../http";
import { createUser, deleteUser, getUser, listUsers, updateUserPassword } from "../models/users";
import { ApiError } from "../types";

interface CreateUserBody {
  username: string;
  password?: string;
}

interface UpdateUserBody {
  password: string;
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
    "/api/users/:id": {
      GET: withErrorHandling(async req => {
        const id = parseIntParam(req.params.id, "id");
        return json(getUser(db, id));
      }),
      PATCH: withErrorHandling(async req => {
        const id = parseIntParam(req.params.id, "id");
        const { session } = requireAuth(req, db);
        if (session.userId !== id) throw new ApiError(403, "Cannot modify another user");

        const body = await readJsonBody<UpdateUserBody>(req);
        if (typeof body.password !== "string") throw new ApiError(400, "password is required");
        const user = await updateUserPassword(db, id, body.password);
        return json(user);
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
