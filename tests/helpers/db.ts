import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../../src/server/db/schema";

/** Fresh, isolated in-memory database for a single test file/run. */
export function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  return db;
}
