import type { ExchangeClient } from '../exchanges/base/ExchangeClient.js';
import { calculateDepthSummaries, aggregateDepthSummaries } from '../exchanges/binance/calculator.js';
import { insertSnapshots, cleanupOldSnapshots } from '../db/writer.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { config } from '../config.js';

export class CollectionScheduler {
  private stopRequested = false;
  private cycleCount = 0;
  private lastCleanup = Date.now();

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

    // Daily cleanup
    if (Date.now() - this.lastCleanup > 24 * 60 * 60 * 1000) {
      const deleted = await cleanupOldSnapshots();
      logger.info({ deleted }, 'Old snapshots cleaned up');
      this.lastCleanup = Date.now();
    }
  }

  private async runExchangeCycle(exchange: ExchangeClient): Promise<void> {
    const cycleStart = Date.now();
    const ts = new Date();

    const pairs = await exchange.getActivePairs();

    const allOrderBooks = [];
    for (let i = 0; i < pairs.length; i += config.BATCH_SIZE) {
      const batch = pairs.slice(i, i + config.BATCH_SIZE);
      // Sequential within each batch — avoids concurrent acquire() race condition
      for (const symbol of batch) {
        allOrderBooks.push(await exchange.getOrderBook(symbol));
      }
      if (i + config.BATCH_SIZE < pairs.length) await sleep(config.BATCH_DELAY_MS);
    }

    const pairSummaries = allOrderBooks.map((book) =>
      book ? calculateDepthSummaries(book) : null
    );

    const aggregated = aggregateDepthSummaries(pairSummaries, exchange.name);

    const rows = aggregated.map((s) => ({ ...s, ts }));
    await insertSnapshots(rows);

    const pairsOk = pairSummaries.filter(Boolean).length;
    const pairsSkipped = pairSummaries.length - pairsOk;

    logger.info({
      event: 'cycle_complete',
      exchange: exchange.name,
      duration_ms: Date.now() - cycleStart,
      pairs_ok: pairsOk,
      pairs_skipped: pairsSkipped,
      cycle: this.cycleCount,
    });
  }
}
