import { z } from 'zod';

export const BybitInstrumentSchema = z.object({
  symbol: z.string(),    // "BTCUSDT"
  baseCoin: z.string(),  // "BTC"
  quoteCoin: z.string(), // "USDT"
  status: z.string(),    // "Trading"
});

export const BybitInstrumentsResponseSchema = z.object({
  retCode: z.number(),
  result: z.object({
    list: z.array(BybitInstrumentSchema),
    nextPageCursor: z.string().optional(),
  }),
});

// Bybit orderbook entries: [price, qty]
export const BybitOrderBookResponseSchema = z.object({
  retCode: z.number(),
  result: z.object({
    s: z.string(),                                  // symbol
    b: z.array(z.tuple([z.string(), z.string()])),  // bids
    a: z.array(z.tuple([z.string(), z.string()])),  // asks
  }),
});
