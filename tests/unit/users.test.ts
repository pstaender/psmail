import { describe, expect, test } from "bun:test";
import { createTestDb } from "../helpers/db";
import {
  createUser,
  deleteUser,
  ensureDefaultUser,
  getUser,
  listUsers,
  updateUserPassword,
  verifyUserPassword,
} from "../../src/server/models/users";
import { ApiError } from "../../src/server/types";

describe("users model", () => {
  test("creates a user and lists it", async () => {
    const db = createTestDb();
    const user = await createUser(db, "alice", "hunter2");

    expect(user.username).toBe("alice");
    expect(listUsers(db).map(u => u.username)).toEqual(["alice"]);
  });

  test("rejects duplicate usernames", async () => {
    const db = createTestDb();
    await createUser(db, "alice", "pw");
    await expect(createUser(db, "alice", "other")).rejects.toThrow(ApiError);
  });

  test("ensureDefaultUser creates 'default' with an empty password exactly once", async () => {
    const db = createTestDb();
    const first = await ensureDefaultUser(db);
    const second = await ensureDefaultUser(db);

    expect(first.id).toBe(second.id);
    expect(first.username).toBe("default");
    expect(listUsers(db)).toHaveLength(1);

    const verified = await verifyUserPassword(db, "default", "");
    expect(verified.username).toBe("default");
  });

  test("verifyUserPassword rejects wrong password", async () => {
    const db = createTestDb();
    await createUser(db, "bob", "correct-password");
    await expect(verifyUserPassword(db, "bob", "wrong-password")).rejects.toThrow(ApiError);
  });

  test("updateUserPassword changes the stored hash", async () => {
    const db = createTestDb();
    const user = await createUser(db, "carol", "old-pw");
    await updateUserPassword(db, user.id, "new-pw");

    await expect(verifyUserPassword(db, "carol", "old-pw")).rejects.toThrow();
    await expect(verifyUserPassword(db, "carol", "new-pw")).resolves.toBeTruthy();
  });

  test("getUser throws for unknown id", () => {
    const db = createTestDb();
    expect(() => getUser(db, 999)).toThrow(ApiError);
  });

  test("deleteUser removes the row", async () => {
    const db = createTestDb();
    const user = await createUser(db, "dave", "pw");
    deleteUser(db, user.id);
    expect(() => getUser(db, user.id)).toThrow(ApiError);
  });
});
