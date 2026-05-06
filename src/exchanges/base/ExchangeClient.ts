import type { OrderBook } from '../../types/shared.js';

export interface ExchangeClient {
  readonly name: string; // "binance" | "bybit" | "okx"

  // Returns all active quote-asset pairs (e.g. all USDT pairs)
  getActivePairs(): Promise<string[]>;

  // Returns normalized order book for one symbol
  // Returns null on error for this pair — caller skips it and continues
  getOrderBook(symbol: string): Promise<OrderBook | null>;
}
