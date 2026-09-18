import { Database } from "bun:sqlite";
import { ConflictError, NotFoundError, type DownloadJob, type DownloadStatus } from "../types";

interface DownloadRow {
  id: number;
  account_id: number;
  folder: string | null;
  status: DownloadStatus;
  progress_current: number;
  progress_total: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

function toJob(row: DownloadRow): DownloadJob {
  return {
    id: row.id,
    accountId: row.account_id,
    folder: row.folder,
    status: row.status,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

/** Only one active (pending/running) download job per account at a time. */
export function createDownloadJob(db: Database, accountId: number, folder: string | null): DownloadJob {
  const active = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM downloads WHERE account_id = ? AND status IN ('pending', 'running')"
    )
    .get(accountId);
  if (active) throw new ConflictError(`Account ${accountId} already has an active download job (#${active.id})`);

  const row = db
    .query<DownloadRow, [number, string | null]>(
      `INSERT INTO downloads (account_id, folder) VALUES (?, ?) RETURNING *`
    )
    .get(accountId, folder);

  return toJob(row!);
}

export function listDownloadJobs(db: Database, accountId: number): DownloadJob[] {
  const rows = db
    .query<DownloadRow, [number]>("SELECT * FROM downloads WHERE account_id = ? ORDER BY id DESC")
    .all(accountId);
  return rows.map(toJob);
}

export function getDownloadJob(db: Database, id: number): DownloadJob {
  const row = db.query<DownloadRow, [number]>("SELECT * FROM downloads WHERE id = ?").get(id);
  if (!row) throw new NotFoundError(`Download job ${id} not found`);
  return toJob(row);
}

export function startDownloadJob(db: Database, id: number, progressTotal: number): DownloadJob {
  const row = db
    .query<DownloadRow, [number, number]>(
      `UPDATE downloads SET status = 'running', progress_total = ?, started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`
    )
    .get(progressTotal, id);
  return toJob(row!);
}

export function updateDownloadProgress(db: Database, id: number, current: number): void {
  db.query("UPDATE downloads SET progress_current = ? WHERE id = ?").run(current, id);
}

export function completeDownloadJob(db: Database, id: number): DownloadJob {
  const row = db
    .query<DownloadRow, [number]>(
      `UPDATE downloads SET status = 'completed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`
    )
    .get(id);
  return toJob(row!);
}

export function failDownloadJob(db: Database, id: number, error: string): DownloadJob {
  const row = db
    .query<DownloadRow, [string, number]>(
      `UPDATE downloads SET status = 'failed', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`
    )
    .get(error, id);
  return toJob(row!);
}

/** Jobs run in-process, so any pending/running job found at startup was orphaned by a killed server. */
export function failInterruptedDownloadJobs(db: Database): number {
  return db
    .query(
      `UPDATE downloads SET status = 'failed', error = 'Interrupted by server restart',
       finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status IN ('pending', 'running')`
    )
    .run().changes;
}
