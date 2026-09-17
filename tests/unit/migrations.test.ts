import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/server/db/migrations";

describe("runMigrations", () => {
  test("adds read_only to an accounts table that predates it, defaulting existing rows to 0", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL
      )
    `);
    db.exec("INSERT INTO accounts (email) VALUES ('me@example.com')");

    runMigrations(db);

    const row = db.query<{ read_only: number }, []>("SELECT read_only FROM accounts").get();
    expect(row?.read_only).toBe(0);
  });

  test("is idempotent — safe to run again against an already-migrated (or freshly-created) table", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        read_only INTEGER NOT NULL DEFAULT 0
      )
    `);

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
  });
});
