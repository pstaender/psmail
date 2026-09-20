import type { Database } from "bun:sqlite";

/**
 * Lightweight migrations for columns added to a table that may already exist in an
 * installed database — `CREATE TABLE IF NOT EXISTS` (schema.ts) only helps brand-new
 * databases; an already-created table needs each new column added explicitly. Every
 * statement is idempotent: run again (e.g. a table created fresh already has the column),
 * SQLite's "duplicate column" error is swallowed rather than treated as a startup failure.
 */
const MIGRATIONS = [
  "ALTER TABLE accounts ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE accounts ADD COLUMN skip_soft_delete INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE accounts ADD COLUMN exclude_from_auto_sync INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE accounts ADD COLUMN imap_uidplus INTEGER",
  "ALTER TABLE accounts ADD COLUMN sender_name TEXT",
  "ALTER TABLE accounts ADD COLUMN signature TEXT",
  "ALTER TABLE accounts ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE accounts ADD COLUMN sent_folder TEXT",
  "ALTER TABLE accounts ADD COLUMN special_folders TEXT",
  "ALTER TABLE accounts ADD COLUMN folders_cache TEXT",
  "ALTER TABLE emails ADD COLUMN taxonomy_list TEXT",
  "ALTER TABLE emails ADD COLUMN ai_summary TEXT",
  "ALTER TABLE emails ADD COLUMN translated_text TEXT",
  "ALTER TABLE emails ADD COLUMN translated_language TEXT",
  "ALTER TABLE ai_apis ADD COLUMN calls INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE ai_apis ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE ai_apis ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'",
];

export function runMigrations(db: Database): void {
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
    }
  }
}
