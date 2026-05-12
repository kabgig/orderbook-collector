import { z } from 'zod';

export const OKXInstrumentSchema = z.object({
  instId: z.string(),    // "BTC-USDT"
  baseCcy: z.string(),   // "BTC"
  quoteCcy: z.string(),  // "USDT"
  state: z.string(),     // "live"
});

export const OKXInstrumentsResponseSchema = z.object({
  code: z.string(),
  data: z.array(OKXInstrumentSchema),
});

// OKX entries: [price, qty, liquidatedOrders, orderCount] — only first two are used
const OKXOrderEntry = z.tuple([z.string(), z.string(), z.string(), z.string()]);

export const OKXOrderBookResponseSchema = z.object({
  code: z.string(),
  data: z.array(z.object({
    asks: z.array(OKXOrderEntry),
    bids: z.array(OKXOrderEntry),
    ts: z.string(),
  })),
});
