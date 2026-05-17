// All DB writes for the correlation service: results table swap + run log lifecycle.
// Results swap runs inside a single transaction (DELETE+INSERT). Postgres MVCC ensures
// concurrent readers (the Next.js API) see either the full old set or the full new set,
// never a partially-rewritten state.

import { sql } from '../db/client.js';
import { logger } from '../utils/logger.js';

export interface CorrelationRow {
  symbol: string;
  correlation: number;
  beta: number;
}

// Atomic full rewrite of the public.correlations table.
// Delisted symbols disappear; new listings appear; existing rows get fresh numbers.
export async function rewriteCorrelations(rows: CorrelationRow[]): Promise<void> {
  if (rows.length === 0) {
    // Defensive: never wipe the table without something to put back. Caller should have
    // logged a failure already; we just refuse to commit an empty replacement.
    logger.warn('rewriteCorrelations called with empty rows — skipping DELETE');
    return;
  }
  await sql.begin(async (tx) => {
    await tx`DELETE FROM public.correlations`;
    // Bulk insert via tagged-template VALUES expansion (postgres lib supports this).
    await tx`
      INSERT INTO public.correlations ${tx(
        rows.map((r) => ({
          symbol: r.symbol,
          correlation: r.correlation,
          beta: r.beta,
          updated_at: new Date(),
        })),
        'symbol', 'correlation', 'beta', 'updated_at',
      )}
    `;
  });
}

// Run log: start, finish (success), finish (failure). One row per run attempt.
export async function startRunLog(): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO public.correlation_run_log (status) VALUES ('running')
    RETURNING id
  `;
  const first = rows[0];
  if (!first) throw new Error('startRunLog: INSERT returned no rows');
  return first.id;
}

export async function finishRunLogSuccess(
  id: number,
  startedAtMs: number,
  counts: { fetched: number; failed: number; skipped: number },
): Promise<void> {
  const duration = Date.now() - startedAtMs;
  await sql`
    UPDATE public.correlation_run_log
    SET status = 'success',
        run_finished_at = NOW(),
        duration_ms = ${duration},
        symbols_fetched = ${counts.fetched},
        symbols_failed = ${counts.failed},
        symbols_skipped = ${counts.skipped}
    WHERE id = ${id}
  `;
}

export async function finishRunLogFailure(
  id: number,
  startedAtMs: number,
  errorMessage: string,
  counts: { fetched: number; failed: number; skipped: number },
): Promise<void> {
  const duration = Date.now() - startedAtMs;
  // Truncate error message defensively — long stack traces would bloat the row.
  const trimmed = errorMessage.length > 2000 ? errorMessage.slice(0, 2000) : errorMessage;
  await sql`
    UPDATE public.correlation_run_log
    SET status = 'failure',
        run_finished_at = NOW(),
        duration_ms = ${duration},
        symbols_fetched = ${counts.fetched},
        symbols_failed = ${counts.failed},
        symbols_skipped = ${counts.skipped},
        error_message = ${trimmed}
    WHERE id = ${id}
  `;
}

// Returns ms-since-epoch of the most recent SUCCESSFUL run, or null if none ever finished.
// Used to decide whether to attempt a fresh run on startup or after the loop tick.
export async function getLastSuccessfulRunMs(): Promise<number | null> {
  const rows = await sql<{ run_started_at: Date }[]>`
    SELECT run_started_at FROM public.correlation_run_log
    WHERE status = 'success'
    ORDER BY run_started_at DESC
    LIMIT 1
  `;
  const first = rows[0];
  if (!first) return null;
  return first.run_started_at.getTime();
}

// Prune run-log rows older than `retentionDays`. Cheap, safe to call after every run.
export async function pruneOldRunLogs(retentionDays: number): Promise<number> {
  const intervalStr = `${retentionDays} days`;
  const result = await sql`
    DELETE FROM public.correlation_run_log
    WHERE run_started_at < NOW() - ${intervalStr}::interval
  `;
  return result.count;
}

// Returns the ms-since-epoch of an admin-requested refresh (or null if none).
// The scheduler runs an update if this timestamp is newer than the last successful run.
// The row is seeded by the migration so we always expect exactly one row.
export async function getRefreshRequestedAtMs(): Promise<number | null> {
  const rows = await sql<{ refresh_requested_at: Date | null }[]>`
    SELECT refresh_requested_at FROM public.correlation_control WHERE id = 1
  `;
  const first = rows[0];
  if (!first || first.refresh_requested_at === null) return null;
  return first.refresh_requested_at.getTime();
}
