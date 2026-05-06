import { describe, it, expect } from 'vitest';
import {
  getMidPrice,
  sumOrderValue,
  calculateDepthSummaries,
  aggregateDepthSummaries,
} from '../src/exchanges/binance/calculator.js';

describe('getMidPrice', () => {
  it('returns average of best bid and best ask', () => {
    const bids: [string, string][] = [['100', '1'], ['99', '2']];
    const asks: [string, string][] = [['101', '1'], ['102', '2']];
    expect(getMidPrice(bids, asks)).toBe(100.5);
  });

  it('throws when bids is empty', () => {
    expect(() => getMidPrice([], [['101', '1']])).toThrow();
  });

  it('throws when asks is empty', () => {
    expect(() => getMidPrice([['100', '1']], [])).toThrow();
  });
});

describe('sumOrderValue', () => {
  const orders: [string, string][] = [['100', '2'], ['95', '1'], ['90', '3'], ['80', '1']];

  it('sums orders within range inclusive of boundaries', () => {
    // 100*2 + 95*1 + 90*3 = 200 + 95 + 270 = 565
    expect(sumOrderValue(orders, 90, 100)).toBeCloseTo(565);
  });

  it('excludes orders outside range', () => {
    // 100*2 + 95*1 = 295
    expect(sumOrderValue(orders, 95, 100)).toBeCloseTo(295);
  });

  it('includes orders exactly at boundary', () => {
    expect(sumOrderValue(orders, 100, 100)).toBeCloseTo(200);
  });

  it('returns 0 for empty array', () => {
    expect(sumOrderValue([], 90, 110)).toBe(0);
  });

  it('returns 0 when no orders in range', () => {
    expect(sumOrderValue(orders, 110, 120)).toBe(0);
  });
});

describe('calculateDepthSummaries', () => {
  const validBook = {
    symbol: 'BTCUSDT',
    exchange: 'binance',
    bids: [['100', '10'], ['99', '5'], ['97', '3']] as [string, string][],
    asks: [['101', '8'], ['103', '4'], ['106', '2']] as [string, string][],
  };

  it('returns null for empty bids', () => {
    expect(calculateDepthSummaries({ ...validBook, bids: [] })).toBeNull();
  });

  it('returns null for empty asks', () => {
    expect(calculateDepthSummaries({ ...validBook, asks: [] })).toBeNull();
  });

  it('returns null when spread exceeds 5%', () => {
    // bestBid=100, bestAsk=110 → spread = 10/105 ≈ 9.5%
    const wideSpreadBook = { ...validBook, asks: [['110', '1']] as [string, string][] };
    expect(calculateDepthSummaries(wideSpreadBook)).toBeNull();
  });

  it('returns 7 summaries for 7 depth levels', () => {
    const result = calculateDepthSummaries(validBook);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(7);
  });

  it('all bid and ask values are non-negative', () => {
    const result = calculateDepthSummaries(validBook)!;
    for (const s of result) {
      expect(s.total_bid).toBeGreaterThanOrEqual(0);
      expect(s.total_ask).toBeGreaterThanOrEqual(0);
    }
  });

  it('each summary has pair_count of 1', () => {
    const result = calculateDepthSummaries(validBook)!;
    for (const s of result) {
      expect(s.pair_count).toBe(1);
    }
  });
});

describe('aggregateDepthSummaries', () => {
  const makeSummaries = (bid: number, ask: number) =>
    [1.5, 3, 5, 8, 15, 30, 60].map((depth_pct) => ({
      depth_pct: depth_pct as (typeof import('../src/types/shared.js').DEPTH_LEVELS)[number],
      total_bid: bid,
      total_ask: ask,
      pair_count: 1,
      exchange: 'binance',
    }));

  it('sums bid/ask across multiple pairs', () => {
    const result = aggregateDepthSummaries(
      [makeSummaries(100, 200), makeSummaries(50, 75)],
      'binance'
    );
    for (const s of result) {
      expect(s.total_bid).toBeCloseTo(150);
      expect(s.total_ask).toBeCloseTo(275);
    }
  });

  it('counts only valid (non-null) pairs', () => {
    const result = aggregateDepthSummaries(
      [makeSummaries(100, 200), null, makeSummaries(50, 75), null],
      'binance'
    );
    for (const s of result) {
      expect(s.pair_count).toBe(2);
    }
  });

  it('handles all-null input gracefully', () => {
    const result = aggregateDepthSummaries([null, null, null], 'binance');
    for (const s of result) {
      expect(s.total_bid).toBe(0);
      expect(s.total_ask).toBe(0);
      expect(s.pair_count).toBe(0);
    }
  });
});
