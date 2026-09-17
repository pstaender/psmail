/**
 * Hashing/verification of user login passwords (argon2id via Bun.password).
 * An empty password (the "default" user's intentionally passwordless
 * profile) is represented by an empty stored hash, since Bun.password
 * rejects hashing an empty string.
 */

export async function hashPassword(password: string): Promise<string> {
  if (password === "") return "";
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (hash === "") return password === "";
  return Bun.password.verify(password, hash);
}
