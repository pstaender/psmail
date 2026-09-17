import type { Database } from "bun:sqlite";
import { getSession, getSessionEncryptionKey, type Session } from "./services/sessions";
import { ApiError, UnauthorizedError } from "./types";

export type Handler = (req: Bun.BunRequest) => Response | Promise<Response>;

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Wraps a handler so thrown ApiErrors (and unexpected errors) become proper JSON error responses. */
export function withErrorHandling(handler: Handler): Handler {
  return async req => {
    try {
      return await handler(req);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: error.message }, { status: error.status });
      }
      console.error(error);
      return json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

export interface AuthContext {
  session: Session;
  encryptionKey: Buffer;
}

/** Reads and validates the Bearer session token from the Authorization header. */
export function requireAuth(req: Bun.BunRequest, db: Database): AuthContext {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) throw new UnauthorizedError("Missing or malformed Authorization header");

  const session = getSession(db, token);
  if (!session) throw new UnauthorizedError("Session expired or invalid");

  const encryptionKey = getSessionEncryptionKey(token);
  if (!encryptionKey) throw new UnauthorizedError("Session key unavailable, please log in again");

  return { session, encryptionKey };
}

export async function readJsonBody<T>(req: Bun.BunRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
}

export function parseIntParam(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n)) throw new ApiError(400, `Invalid ${name}`);
  return n;
}

/** Route params come back as `string | undefined` unless Bun can infer the literal route path; this narrows and validates. */
export function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new ApiError(400, `Missing ${name} param`);
  return value;
}
