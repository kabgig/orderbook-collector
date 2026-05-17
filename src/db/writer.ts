import { sql } from './client.js';
import type { SnapshotRow } from '../types/shared.js';

const TABLES = ['orderbook_snapshots', 'okx_orderbook_snapshots', 'bybit_orderbook_snapshots'] as const;

// Derive table name from the exchange field of the first row
function tableForExchange(exchange: string): string {
  if (exchange.startsWith('okx')) return 'okx_orderbook_snapshots';
  if (exchange.startsWith('bybit')) return 'bybit_orderbook_snapshots';
  return 'orderbook_snapshots';
}

// Insert all depth-level rows in a single query to the exchange-specific table.
// Schema is prefixed literally (`public.`) because Neon's default user has an empty
// search_path, so unqualified names like `orderbook_snapshots` fail to resolve.
export async function insertSnapshots(rows: SnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  const table = tableForExchange(rows[0]!.exchange);
  await sql`
    INSERT INTO public.${sql(table)}
      ${sql(rows, 'ts', 'depth_pct', 'total_bid', 'total_ask', 'pair_count', 'exchange')}
  `;
}

// Delete rows older than retentionDays from all snapshot tables (default 90)
// Returns total number of deleted rows across all tables
export async function cleanupOldSnapshots(retentionDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let total = 0;
  for (const table of TABLES) {
    const result = await sql`DELETE FROM public.${sql(table)} WHERE ts < ${cutoff}`;
    total += result.count;
  }
  return total;
}
