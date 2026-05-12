import type { ExchangeClient } from '../base/ExchangeClient.js';
import type { OrderBook } from '../../types/shared.js';
import { RateLimiter } from '../../utils/rateLimiter.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { BybitInstrumentsResponseSchema, BybitOrderBookResponseSchema } from './types.js';
import { config } from '../../config.js';

const BASE_URL = config.BYBIT_BASE_URL;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Bybit public endpoints: conservative 600/min limit
const RATE_LIMIT_PER_MIN = 600;

const STABLECOIN_BASES = new Set(['USDC', 'TUSD', 'FDUSD', 'USDP', 'DAI', 'BUSD', 'GUSD', 'USDD', 'USTC']);

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

export class BybitClient implements ExchangeClient {
  readonly name = 'bybit';
  private rateLimiter = new RateLimiter(RATE_LIMIT_PER_MIN);
  private instrumentsCache: { instruments: Array<{ symbol: string; baseCoin: string; quoteCoin: string; status: string }>; fetchedAt: number } | null = null;

  private async getInstruments() {
    if (this.instrumentsCache && Date.now() - this.instrumentsCache.fetchedAt < CACHE_TTL_MS) {
      return this.instrumentsCache.instruments;
    }
    // Bybit paginates with cursor — fetch all pages
    const all: Array<{ symbol: string; baseCoin: string; quoteCoin: string; status: string }> = [];
    let cursor: string | undefined;
    do {
      await this.rateLimiter.acquire(1);
      const url = `${BASE_URL}/v5/market/instruments-info?category=spot&limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await fetchWithRetry(url);
      if (!res.ok) throw new Error(`Bybit instruments failed: HTTP ${res.status}`);
      const json = await res.json() as unknown;
      const parsed = BybitInstrumentsResponseSchema.parse(json);
      if (parsed.retCode !== 0) throw new Error(`Bybit instruments error: retCode=${parsed.retCode}`);
      all.push(...parsed.result.list);
      cursor = parsed.result.nextPageCursor;
    } while (cursor);

    this.instrumentsCache = { instruments: all, fetchedAt: Date.now() };
    return all;
  }

  async getPairsForQuotes(quoteAssets: string[]): Promise<string[]> {
    const instruments = await this.getInstruments();
    const pairs = instruments
      .filter((i) => i.status === 'Trading' && quoteAssets.includes(i.quoteCoin) && !STABLECOIN_BASES.has(i.baseCoin))
      .map((i) => i.symbol); // "BTCUSDT"
    logger.debug({ quoteAssets, count: pairs.length }, 'Bybit: fetched active pairs');
    return pairs;
  }

  async getActivePairs(): Promise<string[]> {
    return this.getPairsForQuotes(['USDT']);
  }

  async getOrderBook(symbol: string): Promise<OrderBook | null> {
    await this.rateLimiter.acquire(1);

    let res: Response;
    try {
      res = await fetchWithRetry(`${BASE_URL}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=200`);
    } catch (err) {
      logger.warn({ symbol, err }, 'Bybit: network error fetching order book');
      return null;
    }

    if (res.status === 429) {
      logger.warn({ symbol }, 'Bybit: rate limit hit — sleeping 2s');
      await sleep(2000);
      return null;
    }

    if (!res.ok) {
      logger.warn({ symbol, status: res.status }, 'Bybit: non-OK response for order book');
      return null;
    }

    const json = await res.json() as unknown;
    const parseResult = BybitOrderBookResponseSchema.safeParse(json);
    if (!parseResult.success) {
      logger.warn({ symbol, error: parseResult.error.issues }, 'Bybit: order book schema validation failed');
      return null;
    }

    // Non-zero retCode means the symbol is unavailable/delisted — skip silently
    if (parseResult.data.retCode !== 0) {
      logger.debug({ symbol, retCode: parseResult.data.retCode }, 'Bybit: skipping symbol with non-zero retCode');
      return null;
    }

    const { s, b: bids, a: asks } = parseResult.data.result;
    // Guard against a 0 retCode but still-empty result (shouldn't happen, but be safe)
    if (!s || !bids || !asks) {
      logger.warn({ symbol }, 'Bybit: retCode=0 but result fields missing');
      return null;
    }

    return {
      symbol,
      bids,
      asks,
      exchange: this.name,
    };
  }
}
