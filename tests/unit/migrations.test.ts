import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/server/db/migrations";

describe("runMigrations", () => {
  test("adds read_only to an accounts table that predates it, defaulting existing rows to 0", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT)");
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

  test("adds the AI result columns to a pre-existing emails table", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL)");
    db.exec("INSERT INTO emails DEFAULT VALUES");

    runMigrations(db);

    const row = db.query<Record<string, unknown>, []>("SELECT taxonomy_list, ai_summary, translated_text, translated_language FROM emails").get();
    expect(row).toEqual({ taxonomy_list: null, ai_summary: null, translated_text: null, translated_language: null });
  });

  test("adds users.settings ('{}'), accounts.position and accounts.sent_folder to pre-existing tables", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL)");
    db.exec("INSERT INTO users DEFAULT VALUES");
    db.exec("INSERT INTO accounts (email) VALUES ('me@example.com')");

    runMigrations(db);

    expect(db.query<{ settings: string }, []>("SELECT settings FROM users").get()?.settings).toBe("{}");
    const account = db.query<{ position: number; sent_folder: string | null }, []>("SELECT position, sent_folder FROM accounts").get();
    expect(account).toEqual({ position: 0, sent_folder: null });
  });

  test("is idempotent — safe to run again against an already-migrated (or freshly-created) table", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT)");
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
