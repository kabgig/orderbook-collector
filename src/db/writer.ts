import { sql } from './client.js';
import type { SnapshotRow } from '../types/shared.js';

// Derive table name from the exchange field of the first row.
// Note: 'binance_correlated' lands in the default orderbook_snapshots table — it does
// not start with okx/bybit, so the fall-through branch is correct for it.
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
