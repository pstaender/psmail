import type { Database } from "bun:sqlite";

/**
 * Lightweight migrations for columns added to a table that may already exist in an
 * installed database — `CREATE TABLE IF NOT EXISTS` (schema.ts) only helps brand-new
 * databases; an already-created table needs each new column added explicitly. Every
 * statement is idempotent: run again (e.g. a table created fresh already has the column),
 * SQLite's "duplicate column" error is swallowed rather than treated as a startup failure.
 */
const MIGRATIONS = ["ALTER TABLE accounts ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0"];

export function runMigrations(db: Database): void {
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
    }
  }
}
