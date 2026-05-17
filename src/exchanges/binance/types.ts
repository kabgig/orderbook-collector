import { z } from 'zod';

export const BinanceSymbolSchema = z.object({
  symbol: z.string(),
  status: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
});

export const BinanceExchangeInfoSchema = z.object({
  symbols: z.array(BinanceSymbolSchema),
});

export const BinanceOrderBookSchema = z.object({
  lastUpdateId: z.number(),
  bids: z.array(z.tuple([z.string(), z.string()])),
  asks: z.array(z.tuple([z.string(), z.string()])),
});

export type BinanceOrderBook = z.infer<typeof BinanceOrderBookSchema>;

// Binance /api/v3/klines response: an array of 12-element arrays.
// We only consume openTime (index 0) and close price (index 4); the rest are ignored.
// Schema validates the tuple length and the two fields we read.
export const BinanceKlineSchema = z.tuple([
  z.number(),  // openTime (ms)
  z.string(),  // open
  z.string(),  // high
  z.string(),  // low
  z.string(),  // close
  z.string(),  // volume
  z.number(),  // closeTime (ms)
  z.string(),  // quoteAssetVolume
  z.number(),  // numberOfTrades
  z.string(),  // takerBuyBaseVolume
  z.string(),  // takerBuyQuoteVolume
  z.string(),  // ignore
]);

export const BinanceKlinesSchema = z.array(BinanceKlineSchema);

// Minimal candle shape consumed by the correlation service: timestamp + close price.
export interface KlineCandle {
  openTime: number;
  close: number;
}
