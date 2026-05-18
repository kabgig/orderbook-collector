// Daily correlation update service. Runs in parallel with — and fully isolated from —
// the orderbook aggregation scheduler. Design is intentionally minimal:
//
//   loop every TICK_MS (30s):
//     fetch lastSuccess  (from correlation_run_log)
//     fetch refreshAt    (from correlation_control)
//
//     if lastSuccess > 23h ago        → run daily update
//     else if refreshAt > lastSuccess → run admin-triggered refresh
//     else                            → no-op
//
// No locks. No orphan-heal. No retries. Only one instance is expected to have
// CORRELATION_UPDATES_ENABLED=true, so concurrency isn't a concern. A killed-mid-run
// process leaves a 'running' row in the log (harmless — only 'success' is checked),
// and the next tick on the next process simply runs again.

import { BinanceClient } from '../exchanges/binance/client.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { BTC_REFERENCE_SYMBOL, QUOTE_ASSET, isLeveragedToken } from './exclusions.js';
import { alignByOpenTime, computeCorrelationAndBeta } from './compute.js';
import {
  rewriteCorrelations,
  startRunLog,
  finishRunLogSuccess,
  finishRunLogFailure,
  getLastSuccessfulRunMs,
  pruneOldRunLogs,
  getRefreshRequestedAtMs,
  type CorrelationRow,
} from './writer.js';

const INTERVAL = '1h';
const HISTORY_DAYS = 45;
const HISTORY_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;
// Minimum candles required to compute a meaningful correlation.
// 7 days * 24 hourly candles = 168; we round up to 180 for a small safety buffer.
const MIN_CANDLES = 180;

// How often the loop wakes to check whether a run is due. Short interval is fine —
// each tick is one trivial SELECT against tiny tables. The 30s cadence determines
// the max latency for the admin Refresh button to take effect.
const TICK_MS = 30 * 1000;
// Daily cadence: only run if the most recent SUCCESSFUL run was at least this long ago.
// 23h (not 24h) gives the run a small daily drift window without permanently slipping
// past a 24h boundary because of clock jitter or run-duration variance.
const MIN_SUCCESS_GAP_MS = 23 * 60 * 60 * 1000;
// Run-log retention — older rows are deleted after each successful run.
const LOG_RETENTION_DAYS = 30;

// Inter-symbol delay during the fetch loop. With ~400 symbols × 3 klines calls × weight 2,
// total weight is ~2400 — well below the 6000/min ceiling — but spreading prevents bursts.
const PER_SYMBOL_DELAY_MS = 50;

let stopped = false;

export function stopCorrelationService(): void {
  stopped = true;
}

// Top-level entry point. Returns a promise that resolves when the service is asked to stop.
export async function startCorrelationService(): Promise<void> {
  logger.info({
    interval: INTERVAL,
    historyDays: HISTORY_DAYS,
    minCandles: MIN_CANDLES,
    tickMs: TICK_MS,
    minSuccessGapMs: MIN_SUCCESS_GAP_MS,
  }, '[correlation] service starting');

  while (!stopped) {
    try {
      await maybeRunOnce();
    } catch (err) {
      // Catch-all so a single tick failure can't kill the loop.
      logger.error({ err }, '[correlation] unexpected loop error — sleeping and retrying');
    }
    await sleep(TICK_MS);
  }
  logger.info('[correlation] service stopped');
}

// Decide whether to run based on the two simple signals.
async function maybeRunOnce(): Promise<void> {
  const lastSuccessMs = await getLastSuccessfulRunMs();
  const refreshAtMs = await getRefreshRequestedAtMs();

  const ageMs = lastSuccessMs === null ? Infinity : Date.now() - lastSuccessMs;

  // Refresh is pending when the admin's timestamp is newer than the last success
  // (or if there has never been a success and a refresh was requested at all).
  const refreshPending = refreshAtMs !== null &&
    (lastSuccessMs === null || refreshAtMs > lastSuccessMs);

  if (ageMs >= MIN_SUCCESS_GAP_MS) {
    logger.info({ lastSuccessAgeMs: ageMs }, '[correlation] daily check triggered');
    await runUpdate('daily');
  } else if (refreshPending) {
    logger.info({ refreshAtMs }, '[correlation] admin refresh triggered');
    await runUpdate('refresh');
  } else {
    logger.debug({ ageMs, refreshAtMs }, '[correlation] no action this tick');
  }
}

// Full update: fetch pairs -> fetch klines -> compute -> rewrite table -> prune logs.
async function runUpdate(trigger: 'daily' | 'refresh'): Promise<void> {
  const runId = await startRunLog();
  const startedAt = Date.now();
  const counts = { fetched: 0, failed: 0, skipped: 0 };

  try {
    // Dedicated client instance — does not share the aggregation client's rate limiter
    // (per "isolated parallel flows"). On a non-Binance collector instance this means
    // zero contention; on a Binance instance the two limiters share an IP budget but
    // combined weight stays well under the 6000/min cap.
    const client = new BinanceClient();

    // Discover universe: all */USDT pairs minus stablecoins (handled by getPairsForQuotes)
    // and minus leveraged tokens (filtered here).
    const rawPairs = await client.getPairsForQuotes([QUOTE_ASSET]);
    const pairs = rawPairs.filter((s) => !isLeveragedToken(s));
    logger.info({ trigger, total: rawPairs.length, afterLeverageFilter: pairs.length }, '[correlation] universe resolved');

    // Make sure BTC reference is in the list — we always need its klines.
    if (!pairs.includes(BTC_REFERENCE_SYMBOL)) {
      throw new Error(`${BTC_REFERENCE_SYMBOL} missing from active pairs — cannot compute correlations`);
    }

    const endTimeMs = Date.now();
    const startTimeMs = endTimeMs - HISTORY_MS;

    // Fetch BTC klines first — they're the reference series for every pair.
    const btcCandles = await client.getKlines(BTC_REFERENCE_SYMBOL, INTERVAL, startTimeMs, endTimeMs);
    if (btcCandles.length < MIN_CANDLES) {
      throw new Error(`BTC klines too short (${btcCandles.length} < ${MIN_CANDLES}) — aborting run`);
    }
    counts.fetched++;
    logger.info({ btcCandles: btcCandles.length }, '[correlation] BTC reference series fetched');

    const results: CorrelationRow[] = [];
    // BTC self-row: reference, definitionally 1.0 correlation and beta.
    results.push({ symbol: BTC_REFERENCE_SYMBOL, correlation: 1, beta: 1 });

    // Sequential fetch — keeps load predictable and avoids burst-triggered 429s.
    for (const symbol of pairs) {
      if (symbol === BTC_REFERENCE_SYMBOL) continue;
      if (stopped) {
        logger.warn('[correlation] stop signal mid-run — finalising partial results');
        break;
      }

      try {
        const candles = await client.getKlines(symbol, INTERVAL, startTimeMs, endTimeMs);
        if (candles.length < MIN_CANDLES) {
          counts.skipped++;
          logger.debug({ symbol, candleCount: candles.length }, '[correlation] history too short — skipped');
        } else {
          const aligned = alignByOpenTime(candles, btcCandles, MIN_CANDLES);
          if (aligned === null) {
            counts.skipped++;
            logger.debug({ symbol }, '[correlation] alignment yielded too few overlapping points — skipped');
          } else {
            const { correlation, beta } = computeCorrelationAndBeta(aligned.pairPrices, aligned.btcPrices);
            results.push({ symbol, correlation, beta });
            counts.fetched++;
          }
        }
      } catch (err) {
        counts.failed++;
        logger.warn({ symbol, err }, '[correlation] symbol failed — continuing');
      }

      if (PER_SYMBOL_DELAY_MS > 0) await sleep(PER_SYMBOL_DELAY_MS);
    }

    if (results.length === 0) {
      throw new Error('No correlations computed — refusing to wipe table');
    }

    // Atomic swap: readers see either old or new full set, never partial.
    await rewriteCorrelations(results);
    await finishRunLogSuccess(runId, startedAt, counts);

    const durationMs = Date.now() - startedAt;
    logger.info({
      trigger,
      duration_ms: durationMs,
      rows: results.length,
      ...counts,
    }, '[correlation] update completed');

    // Best-effort prune of old log rows. Errors here don't fail the run.
    try {
      const pruned = await pruneOldRunLogs(LOG_RETENTION_DAYS);
      if (pruned > 0) logger.debug({ pruned }, '[correlation] pruned old run-log rows');
    } catch (err) {
      logger.warn({ err }, '[correlation] log prune failed (non-fatal)');
    }
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    await finishRunLogFailure(runId, startedAt, message, counts).catch((logErr) => {
      logger.error({ logErr }, '[correlation] failed to write failure log row');
    });
    logger.error({ err, trigger, ...counts }, '[correlation] update failed');
  }
}
