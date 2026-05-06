import type { ExchangeClient } from '../base/ExchangeClient.js';
import type { OrderBook } from '../../types/shared.js';
import { RateLimiter } from '../../utils/rateLimiter.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { BinanceExchangeInfoSchema, BinanceOrderBookSchema } from './types.js';

const BASE_URL = 'https://api.binance.com';
const ORDERBOOK_WEIGHT = 10;      // weight for limit=1000
const EXCHANGE_INFO_WEIGHT = 20;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
  private pairsCache: { pairs: string[]; fetchedAt: number } | null = null;

  async getActivePairs(): Promise<string[]> {
    if (this.pairsCache && Date.now() - this.pairsCache.fetchedAt < CACHE_TTL_MS) {
      return this.pairsCache.pairs;
    }

    await this.rateLimiter.acquire(EXCHANGE_INFO_WEIGHT);
    const res = await fetchWithRetry(`${BASE_URL}/api/v3/exchangeInfo`);

    if (!res.ok) {
      throw new Error(`exchangeInfo failed: HTTP ${res.status}`);
    }

    const json = await res.json() as unknown;
    const parsed = BinanceExchangeInfoSchema.parse(json);

    const pairs = parsed.symbols
      .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map((s) => s.symbol);

    this.pairsCache = { pairs, fetchedAt: Date.now() };
    logger.debug({ count: pairs.length }, 'Fetched active pairs');
    return pairs;
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
}
