import type { ExchangeClient } from '../base/ExchangeClient.js';
import type { OrderBook } from '../../types/shared.js';
import { RateLimiter } from '../../utils/rateLimiter.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import { OKXInstrumentsResponseSchema, OKXOrderBookResponseSchema } from './types.js';
import { config } from '../../config.js';

const BASE_URL = config.OKX_BASE_URL;
const CACHE_TTL_MS = 10 * 60 * 1000;

// OKX rate limit: 20 req/2s per endpoint = 600/min
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

export class OKXClient implements ExchangeClient {
  readonly name = 'okx';
  private rateLimiter = new RateLimiter(RATE_LIMIT_PER_MIN);
  private instrumentsCache: { instruments: Array<{ instId: string; baseCcy: string; quoteCcy: string }>; fetchedAt: number } | null = null;

  private async getInstruments() {
    if (this.instrumentsCache && Date.now() - this.instrumentsCache.fetchedAt < CACHE_TTL_MS) {
      return this.instrumentsCache.instruments;
    }
    await this.rateLimiter.acquire(1);
    const res = await fetchWithRetry(`${BASE_URL}/api/v5/public/instruments?instType=SPOT`);
    if (!res.ok) throw new Error(`OKX instruments failed: HTTP ${res.status}`);
    const json = await res.json() as unknown;
    const parsed = OKXInstrumentsResponseSchema.parse(json);
    if (parsed.code !== '0') throw new Error(`OKX instruments error: code=${parsed.code}`);
    const instruments = parsed.data.filter((i) => i.state === 'live');
    this.instrumentsCache = { instruments, fetchedAt: Date.now() };
    return instruments;
  }

  async getPairsForQuotes(quoteAssets: string[]): Promise<string[]> {
    const instruments = await this.getInstruments();
    const pairs = instruments
      .filter((i) => quoteAssets.includes(i.quoteCcy) && !STABLECOIN_BASES.has(i.baseCcy))
      .map((i) => i.instId); // "BTC-USDT"
    logger.debug({ quoteAssets, count: pairs.length }, 'OKX: fetched active pairs');
    return pairs;
  }

  async getActivePairs(): Promise<string[]> {
    return this.getPairsForQuotes(['USDT']);
  }

  async getOrderBook(symbol: string): Promise<OrderBook | null> {
    await this.rateLimiter.acquire(1);

    let res: Response;
    try {
      res = await fetchWithRetry(`${BASE_URL}/api/v5/market/books?instId=${symbol}&sz=400`);
    } catch (err) {
      logger.warn({ symbol, err }, 'OKX: network error fetching order book');
      return null;
    }

    if (res.status === 429) {
      logger.warn({ symbol }, 'OKX: rate limit hit — sleeping 2s');
      await sleep(2000);
      return null;
    }

    if (!res.ok) {
      logger.warn({ symbol, status: res.status }, 'OKX: non-OK response for order book');
      return null;
    }

    const json = await res.json() as unknown;
    const parseResult = OKXOrderBookResponseSchema.safeParse(json);
    if (!parseResult.success) {
      logger.warn({ symbol, error: parseResult.error.message }, 'OKX: order book schema validation failed');
      return null;
    }

    if (parseResult.data.code !== '0' || parseResult.data.data.length === 0) {
      logger.warn({ symbol, code: parseResult.data.code }, 'OKX: empty or error response');
      return null;
    }

    const book = parseResult.data.data[0]!;
    return {
      symbol,
      // Normalize: drop extra OKX fields, keep only [price, qty]
      bids: book.bids.map(([price, qty]) => [price, qty] as [string, string]),
      asks: book.asks.map(([price, qty]) => [price, qty] as [string, string]),
      exchange: this.name,
    };
  }
}
