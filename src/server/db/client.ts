import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { getDatabasePath } from "../config/paths";
import { SCHEMA_SQL } from "./schema";
import { runMigrations } from "./migrations";
import { normalizeAccountPositions } from "../models/accounts";
import { rebuildContactsIfEmpty, tidyContactNames } from "../models/contacts";

let instance: Database | null = null;

/**
 * Opens (or returns the cached) sqlite database. Pass an explicit `path`
 * (e.g. ":memory:" or a temp file) to override the default config-dir
 * location — primarily used by tests.
 */
export function getDb(path?: string): Database {
  if (instance) return instance;

  const dbPath = path ?? getDatabasePath();
  if (dbPath !== ":memory:") {
    Bun.spawnSync(["mkdir", "-p", dirname(dbPath)]);
  }

  instance = new Database(dbPath, { create: true });
  instance.exec("PRAGMA journal_mode = WAL;");
  instance.exec("PRAGMA foreign_keys = ON;");
  instance.exec(SCHEMA_SQL);
  runMigrations(instance);
  normalizeAccountPositions(instance);
  rebuildContactsIfEmpty(instance);
  tidyContactNames(instance);
  return instance;
}

/** For tests: close and drop the cached instance so a fresh db can be opened. */
export function resetDb(): void {
  instance?.close();
  instance = null;
}
