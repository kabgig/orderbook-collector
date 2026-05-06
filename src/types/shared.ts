// Depth levels as const — used across all exchanges
export const DEPTH_LEVELS = [1.5, 3, 5, 8, 15, 30, 60] as const;
export type DepthLevel = (typeof DEPTH_LEVELS)[number];

// Normalized order book — same shape regardless of exchange
export interface OrderBook {
  symbol: string;           // normalized: "BTCUSDT"
  bids: [string, string][]; // [price, qty] strings — parse to number in calculator
  asks: [string, string][];
  exchange: string;         // "binance" | "bybit" | "okx"
}

// Result of depth calculation for one exchange + one depth level
export interface DepthSummary {
  depth_pct: DepthLevel;
  total_bid: number; // USD value
  total_ask: number; // USD value
  pair_count: number;
  exchange: string;
}

// One DB row (matches orderbook_snapshots table)
export interface SnapshotRow {
  ts: Date;
  depth_pct: DepthLevel;
  total_bid: number;
  total_ask: number;
  pair_count: number;
  exchange: string;
}
