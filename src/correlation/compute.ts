// Pure math: log-returns + Pearson correlation + beta.
// Operates on already-aligned price series (caller ensures same timestamps in same order).

import type { KlineCandle } from '../exchanges/binance/types.js';

export interface CorrelationResult {
  correlation: number;  // Pearson, range [-1, 1]
  beta: number;         // cov(pair, btc) / var(btc); sensitivity to BTC moves
  sampleSize: number;   // number of return points used (candles - 1)
}

// Convert price series to log returns: r[i] = ln(p[i] / p[i-1]).
// Skips intervals where either price is non-positive (defensive — Binance data shouldn't have these).
function logReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1] ?? 0;
    const cur = prices[i] ?? 0;
    if (prev > 0 && cur > 0) {
      out.push(Math.log(cur / prev));
    } else {
      // Push 0 to keep arrays aligned with the BTC series — gaps would break index alignment.
      out.push(0);
    }
  }
  return out;
}

// Build an aligned-by-openTime price array: returns null if fewer than `minPoints` overlapping points.
// Both series come from Binance klines so timestamps should already match on hourly boundaries,
// but symbols listed mid-window won't have early candles — we take the intersection.
export function alignByOpenTime(
  pair: KlineCandle[],
  btc: KlineCandle[],
  minPoints: number,
): { pairPrices: number[]; btcPrices: number[] } | null {
  if (pair.length < minPoints || btc.length < minPoints) return null;

  // Map BTC by openTime for O(1) lookup
  const btcByTime = new Map<number, number>();
  for (const c of btc) btcByTime.set(c.openTime, c.close);

  const pairPrices: number[] = [];
  const btcPrices: number[] = [];
  for (const c of pair) {
    const btcClose = btcByTime.get(c.openTime);
    if (btcClose !== undefined) {
      pairPrices.push(c.close);
      btcPrices.push(btcClose);
    }
  }
  if (pairPrices.length < minPoints) return null;
  return { pairPrices, btcPrices };
}

// Pearson correlation + beta computed from two equal-length return arrays.
// Returns NaN-safe zeros if variance is zero (avoids division by zero for constant series).
export function computeCorrelationAndBeta(
  pairPrices: number[],
  btcPrices: number[],
): CorrelationResult {
  const rPair = logReturns(pairPrices);
  const rBtc = logReturns(btcPrices);
  const n = rPair.length;

  if (n === 0) return { correlation: 0, beta: 0, sampleSize: 0 };

  // Means
  let meanPair = 0, meanBtc = 0;
  for (let i = 0; i < n; i++) {
    meanPair += rPair[i] ?? 0;
    meanBtc += rBtc[i] ?? 0;
  }
  meanPair /= n;
  meanBtc /= n;

  // Covariance + variances (single pass over centered values)
  let cov = 0, varPair = 0, varBtc = 0;
  for (let i = 0; i < n; i++) {
    const dp = (rPair[i] ?? 0) - meanPair;
    const db = (rBtc[i] ?? 0) - meanBtc;
    cov += dp * db;
    varPair += dp * dp;
    varBtc += db * db;
  }
  // n-1 vs n cancels in the correlation ratio; using n for both is fine and slightly cheaper.

  // Guard against zero-variance (constant price series, e.g. delisted/halted)
  if (varPair === 0 || varBtc === 0) {
    return { correlation: 0, beta: 0, sampleSize: n };
  }

  const correlation = cov / Math.sqrt(varPair * varBtc);
  const beta = cov / varBtc;

  // Clamp correlation to [-1, 1] to absorb tiny floating-point overshoot
  const clamped = Math.max(-1, Math.min(1, correlation));

  return { correlation: clamped, beta, sampleSize: n };
}
