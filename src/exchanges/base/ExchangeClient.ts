import type { OrderBook } from '../../types/shared.js';

export interface ExchangeClient {
  readonly name: string; // "binance" | "bybit" | "okx"

  // Returns all active USDT pairs (excludes stablecoin bases)
  getActivePairs(): Promise<string[]>;

  // Returns active pairs for the given quote assets (e.g. ['USDT', 'USDC'])
  getPairsForQuotes(quoteAssets: string[]): Promise<string[]>;

  // Returns normalized order book for one symbol
  // Returns null on error for this pair — caller skips it and continues
  getOrderBook(symbol: string): Promise<OrderBook | null>;
}
