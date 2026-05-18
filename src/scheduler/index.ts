import type { ExchangeClient } from '../exchanges/base/ExchangeClient.js';
import { calculateDepthSummaries, aggregateDepthSummaries, aggregateClassicDepthSummaries } from '../exchanges/binance/calculator.js';
import { insertSnapshots } from '../db/writer.js';
import { tryClaimFetchSlot } from '../db/coordination.js';
import { getCorrelatedSymbols } from '../db/correlatedPairs.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { config } from '../config.js';

export class CollectionScheduler {
  private stopRequested = false;
  private cycleCount = 0;

  constructor(private readonly exchanges: ExchangeClient[]) {}

  async start(): Promise<void> {
    logger.info({ exchanges: this.exchanges.map((e) => e.name) }, 'Scheduler starting');

    while (!this.stopRequested) {
      const cycleStart = Date.now();
      await this.runCycle();
      const cycleDuration = Date.now() - cycleStart;

      const waitMs = Math.max(0, config.COLLECTION_INTERVAL_MS - cycleDuration);
      if (!this.stopRequested) await sleep(waitMs);
    }

    logger.info('Scheduler stopped cleanly');
  }

  stop(): void {
    logger.info('Stop requested — finishing current cycle...');
    this.stopRequested = true;
  }

  private async runCycle(): Promise<void> {
    this.cycleCount++;

    const results = await Promise.allSettled(
      this.exchanges.map((exchange) => this.runExchangeCycle(exchange))
    );

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        logger.error(
          { exchange: this.exchanges[i]?.name, err: result.reason },
          'Exchange cycle failed'
        );
      }
    });
  }

  private async fetchOrderBooks(exchange: ExchangeClient, pairs: string[]) {
    const books = [];
    for (let i = 0; i < pairs.length; i += config.BATCH_SIZE) {
      const batch = pairs.slice(i, i + config.BATCH_SIZE);
      for (const symbol of batch) {
        books.push(await exchange.getOrderBook(symbol));
      }
      if (i + config.BATCH_SIZE < pairs.length) await sleep(config.BATCH_DELAY_MS);
    }
    return books;
  }

  // Block until this instance wins a coordinated fetch slot (or stop is requested).
  // Returns true if a slot was claimed, false if the scheduler is shutting down.
  private async waitForCoordinationSlot(dataset: string): Promise<boolean> {
    const waitStart = Date.now();
    let attempts = 0;

    while (!this.stopRequested) {
      attempts++;
      try {
        const result = await tryClaimFetchSlot(dataset, config.COORDINATION_MIN_GAP_MS);
        if (result.won) {
          logger.info({
            event: 'coordination_slot_won',
            dataset,
            attempts,
            wait_ms: Date.now() - waitStart,
            cycle: this.cycleCount,
          }, `Coordination: claimed fetch slot for '${dataset}' after ${attempts} attempt(s), waited ${Date.now() - waitStart}ms`);
          return true;
        }

        // Lost the race — another instance fetched recently. Sleep and retry.
        const ageMs = result.lastFetch ? Date.now() - result.lastFetch.getTime() : null;
        logger.info({
          event: 'coordination_slot_busy',
          dataset,
          attempts,
          last_fetch_age_ms: ageMs,
          min_gap_ms: config.COORDINATION_MIN_GAP_MS,
          retry_in_ms: config.COORDINATION_RETRY_MS,
          cycle: this.cycleCount,
        }, `Coordination: slot for '${dataset}' busy (last fetch ${ageMs ?? '?'}ms ago, min gap ${config.COORDINATION_MIN_GAP_MS}ms) — retrying in ${config.COORDINATION_RETRY_MS}ms`);
      } catch (err) {
        // DB error during claim — log loudly and back off, so a flaky DB does not silently halt fetching.
        logger.error({
          event: 'coordination_claim_error',
          dataset,
          attempts,
          err,
          retry_in_ms: config.COORDINATION_RETRY_MS,
          cycle: this.cycleCount,
        }, `Coordination: failed to claim slot for '${dataset}' — retrying in ${config.COORDINATION_RETRY_MS}ms`);
      }

      await sleep(config.COORDINATION_RETRY_MS);
    }

    return false;
  }

  private async runExchangeCycle(exchange: ExchangeClient): Promise<void> {
    const cycleStart = Date.now();
    const dataset = config.DATASET;

    // Coordination gate — only active when COORDINATED=true (default false).
    // When inactive, the cycle behaves exactly as before.
    if (config.COORDINATED) {
      const claimed = await this.waitForCoordinationSlot(dataset);
      if (!claimed) return; // shutdown requested mid-wait
    }

    // ts is captured AFTER the claim so the row timestamp matches the actual fetch start.
    const ts = new Date();

    // Fetch pairs based on dataset suffix — all exchange clients implement getPairsForQuotes.
    // For 'binance_correlated': intersect the active Binance USDT universe with the set of
    // symbols whose stored BTC correlation is > 0 (missing rows are excluded by definition).
    let pairs: string[];
    if (dataset === 'binance_correlated') {
      const activePairs = await exchange.getActivePairs();
      const correlatedSet = new Set(await getCorrelatedSymbols());
      pairs = activePairs.filter((p) => correlatedSet.has(p));
      logger.info({
        dataset,
        exchange: exchange.name,
        active: activePairs.length,
        correlated_universe: correlatedSet.size,
        intersected: pairs.length,
      }, 'Correlated pair set resolved');
    } else if (dataset.endsWith('_usdt_usdc')) {
      pairs = await exchange.getPairsForQuotes(['USDT', 'USDC']);
    } else {
      pairs = await exchange.getActivePairs();
    }

    const allBooks = await this.fetchOrderBooks(exchange, pairs);

    const summaries = allBooks.map((book) => book ? calculateDepthSummaries(book) : null);

    const aggregated = dataset.endsWith('_classic')
      ? aggregateClassicDepthSummaries(allBooks, summaries, exchange.name)
      : aggregateDepthSummaries(summaries, dataset);

    const rows = aggregated.map((s) => ({ ...s, ts }));
    await insertSnapshots(rows);

    const totalOk = summaries.filter(Boolean).length;
    const totalSkipped = summaries.length - totalOk;

    logger.info({
      event: 'cycle_complete',
      dataset,
      exchange: exchange.name,
      coordinated: config.COORDINATED,
      duration_ms: Date.now() - cycleStart,
      pairs_ok: totalOk,
      pairs_skipped: totalSkipped,
      cycle: this.cycleCount,
    }, config.COORDINATED
      ? `Coordinated fetch OK for '${dataset}': ${totalOk} pairs in ${Date.now() - cycleStart}ms (cycle ${this.cycleCount})`
      : `Fetch OK for '${dataset}': ${totalOk} pairs in ${Date.now() - cycleStart}ms (cycle ${this.cycleCount})`);
  }
}
