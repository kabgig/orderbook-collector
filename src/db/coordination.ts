import { sql } from './client.js';

export interface ClaimResult {
  won: boolean;
  // The current last_fetch timestamp for the dataset (only set when won=false,
  // so the caller can report how long ago another instance fetched).
  lastFetch?: Date;
}

// Atomically try to claim a fetch slot for `dataset`.
// Uses a single UPSERT whose UPDATE is gated by `WHERE last_fetch < NOW() - minGapMs`.
// Postgres row-locks the conflicting row before evaluating the WHERE, so concurrent
// callers cannot both win — at most one RETURNING row is produced per minGapMs window.
export async function tryClaimFetchSlot(
  dataset: string,
  minGapMs: number,
): Promise<ClaimResult> {
  const intervalStr = `${minGapMs} milliseconds`;

  // Try to claim: insert fresh row, or update existing row only if gap has elapsed.
  const rows = await sql<{ last_fetch: Date }[]>`
    INSERT INTO public.dataset_fetch_locks (dataset, last_fetch)
    VALUES (${dataset}, NOW())
    ON CONFLICT (dataset) DO UPDATE
      SET last_fetch = NOW()
      WHERE public.dataset_fetch_locks.last_fetch < NOW() - ${intervalStr}::interval
    RETURNING last_fetch
  `;

  if (rows.length === 1) return { won: true };

  // Lost the race — read the current timestamp for diagnostics.
  const current = await sql<{ last_fetch: Date }[]>`
    SELECT last_fetch FROM public.dataset_fetch_locks WHERE dataset = ${dataset}
  `;
  return { won: false, lastFetch: current[0]?.last_fetch };
}
