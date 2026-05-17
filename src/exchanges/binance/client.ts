import type { ExchangeClient } from '../base/ExchangeClient.js';
import type { OrderBook } from '../../types/shared.js';
import { RateLimiter } from '../../utils/rateLimiter.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { z } from 'zod';
import { BinanceExchangeInfoSchema, BinanceOrderBookSchema, BinanceKlinesSchema, type KlineCandle } from './types.js';
import { config } from '../../config.js';

const BASE_URL = config.BINANCE_BASE_URL;
const ORDERBOOK_WEIGHT = 10;      // weight for limit=1000
const EXCHANGE_INFO_WEIGHT = 20;
const KLINES_WEIGHT = 2;          // weight for /api/v3/klines (any limit <= 1000)
const KLINES_MAX_LIMIT = 1000;    // hard cap per Binance docs
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min cache — base URL configurable via BINANCE_BASE_URL env var

// Stablecoin base assets to exclude — their USDT pairs have huge artificial liquidity
// that inflates order book totals without reflecting real market demand.
// Exported so other services (e.g. correlation) can use the same source of truth.
export const STABLECOIN_BASES = new Set(['USDC', 'TUSD', 'FDUSD', 'USDP', 'DAI', 'BUSD', 'GUSD', 'USDD', 'USTC']);

async function fetchWithRetry(url: string, maxRetries = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

export class BinanceClient implements ExchangeClient {
  readonly name = 'binance';
  private rateLimiter = new RateLimiter(6000);
  // Cache raw symbols — shared across all quote-asset filter calls
  private symbolsCache: { symbols: z.infer<typeof BinanceExchangeInfoSchema>['symbols']; fetchedAt: number } | null = null;

  private async getSymbols() {
    if (this.symbolsCache && Date.now() - this.symbolsCache.fetchedAt < CACHE_TTL_MS) {
      return this.symbolsCache.symbols;
    }
    await this.rateLimiter.acquire(EXCHANGE_INFO_WEIGHT);
    const res = await fetchWithRetry(`${BASE_URL}/api/v3/exchangeInfo`);
    // Calibrate local weight from Binance's actual counter — critical on process startup
    this.rateLimiter.syncFromHeader(res.headers.get('X-MBX-USED-WEIGHT-1M'));
    if (res.status === 418) {
      logger.fatal('IP banned by Binance (418) during exchangeInfo — waiting 10 min before exit');
      await sleep(10 * 60 * 1000);
      throw new Error('Binance IP ban (418)');
    }
    if (!res.ok) throw new Error(`exchangeInfo failed: HTTP ${res.status}`);
    const json = await res.json() as unknown;
    const parsed = BinanceExchangeInfoSchema.parse(json);
    this.symbolsCache = { symbols: parsed.symbols, fetchedAt: Date.now() };
    return parsed.symbols;
  }

  // Returns all active trading pairs whose quote asset is in quoteAssets, excluding stablecoin bases
  async getPairsForQuotes(quoteAssets: string[]): Promise<string[]> {
    const symbols = await this.getSymbols();
    const pairs = symbols
      .filter((s) => s.status === 'TRADING' && quoteAssets.includes(s.quoteAsset) && !STABLECOIN_BASES.has(s.baseAsset))
      .map((s) => s.symbol);
    logger.debug({ quoteAssets, count: pairs.length }, 'Fetched active pairs');
    return pairs;
  }

  async getActivePairs(): Promise<string[]> {
    return this.getPairsForQuotes(['USDT']);
  }

  async getOrderBook(symbol: string): Promise<OrderBook | null> {
    await this.rateLimiter.acquire(ORDERBOOK_WEIGHT);

    let res: Response;
    try {
      res = await fetchWithRetry(`${BASE_URL}/api/v3/depth?symbol=${symbol}&limit=1000`);
    } catch (err) {
      logger.warn({ symbol, err }, 'Network error fetching order book');
      return null;
    }

    // Sync rate limit from response header
    this.rateLimiter.syncFromHeader(res.headers.get('X-MBX-USED-WEIGHT-1M'));

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      logger.warn({ symbol, retryAfter }, 'Rate limit hit — sleeping');
      await sleep(retryAfter * 1000);
      return null;
    }

    if (res.status === 418) {
      logger.fatal({ symbol }, 'IP banned by Binance (418) — stopping');
      throw new Error('Binance IP ban (418)');
    }

    if (!res.ok) {
      logger.warn({ symbol, status: res.status }, 'Non-OK response for order book');
      return null;
    }

    const json = await res.json() as unknown;
    const parseResult = BinanceOrderBookSchema.safeParse(json);
    if (!parseResult.success) {
      logger.warn({ symbol, error: parseResult.error.message }, 'Order book schema validation failed');
      return null;
    }

    return {
      symbol,
      bids: parseResult.data.bids,
      asks: parseResult.data.asks,
      exchange: this.name,
    };
  }

  // Fetch historical klines (candles) for a symbol over [startTimeMs, endTimeMs].
  // Used by the correlation service only — does NOT affect any aggregation flow.
  // Loops because /api/v3/klines caps each response at 1000 candles; advances the
  // cursor past the last returned openTime+1ms to avoid duplicates.
  // Returns candles sorted ascending by openTime, possibly empty if the symbol has no history.
  async getKlines(symbol: string, interval: string, startTimeMs: number, endTimeMs: number): Promise<KlineCandle[]> {
    const out: KlineCandle[] = [];
    let cursor = startTimeMs;
    // Hard safety bound: should never need more than a few iterations.
    const MAX_ITERATIONS = 20;
    for (let i = 0; i < MAX_ITERATIONS && cursor < endTimeMs; i++) {
      await this.rateLimiter.acquire(KLINES_WEIGHT);

      const url = `${BASE_URL}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTimeMs}&limit=${KLINES_MAX_LIMIT}`;
      let res: Response;
      try {
        res = await fetchWithRetry(url);
      } catch (err) {
        logger.warn({ symbol, interval, err }, 'Network error fetching klines');
        return out;
      }
      this.rateLimiter.syncFromHeader(res.headers.get('X-MBX-USED-WEIGHT-1M'));

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
        logger.warn({ symbol, retryAfter }, 'Rate limit hit on klines — sleeping');
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status === 418) {
        logger.fatal({ symbol }, 'IP banned by Binance (418) on klines — stopping');
        throw new Error('Binance IP ban (418)');
      }
      if (res.status === 400) {
        // Invalid symbol or out-of-range — return what we have (often nothing)
        logger.debug({ symbol, interval }, 'Klines 400 — likely invalid symbol or pre-listing range');
        return out;
      }
      if (!res.ok) {
        logger.warn({ symbol, status: res.status }, 'Non-OK response for klines');
        return out;
      }

      const json = await res.json() as unknown;
      const parsed = BinanceKlinesSchema.safeParse(json);
      if (!parsed.success) {
        logger.warn({ symbol, error: parsed.error.message }, 'Klines schema validation failed');
        return out;
      }

      if (parsed.data.length === 0) break;

      for (const k of parsed.data) {
        const close = Number(k[4]);
        // Defensive: skip rows with NaN close (shouldn't happen but cheaper than failing later)
        if (Number.isFinite(close)) out.push({ openTime: k[0], close });
      }

      // Advance past the last candle's open time; +1ms because Binance startTime is inclusive
      const last = parsed.data[parsed.data.length - 1];
      if (!last) break;
      cursor = last[0] + 1;
    }
    return out;
  }
}
