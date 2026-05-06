import { sql } from './client.js';
import type { SnapshotRow } from '../types/shared.js';

// Insert all depth-level rows in a single query
export async function insertSnapshots(rows: SnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    INSERT INTO orderbook_snapshots
      ${sql(rows, 'ts', 'depth_pct', 'total_bid', 'total_ask', 'pair_count', 'exchange')}
  `;
}

// Delete rows older than retentionDays (default 90)
// Returns number of deleted rows
export async function cleanupOldSnapshots(retentionDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await sql`
    DELETE FROM orderbook_snapshots
    WHERE ts < ${cutoff}
  `;
  return result.count;
}
