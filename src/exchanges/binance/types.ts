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
