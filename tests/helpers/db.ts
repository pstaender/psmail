import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../../src/server/db/schema";
import { runMigrations } from "../../src/server/db/migrations";

/** Fresh, isolated in-memory database for a single test file/run. */
export function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  runMigrations(db); // as the real database is opened: indexes on migrated columns come from here
  return db;
}
