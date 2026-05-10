import type { ExchangeClient } from '../exchanges/base/ExchangeClient.js';
import type { BinanceClient } from '../exchanges/binance/client.js';
import { calculateDepthSummaries, aggregateDepthSummaries, aggregateClassicDepthSummaries } from '../exchanges/binance/calculator.js';
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

  private async runExchangeCycle(exchange: ExchangeClient): Promise<void> {
    const cycleStart = Date.now();
    const ts = new Date();

    // USDT pairs — used for standard and classic sets
    const usdtPairs = await exchange.getActivePairs();
    const usdtBooks = await this.fetchOrderBooks(exchange, usdtPairs);
    const usdtSummaries = usdtBooks.map((book) => book ? calculateDepthSummaries(book) : null);

    // USDC pairs — disabled until a separate instance is dedicated to this dataset
    const hasMultiQuote = 'getPairsForQuotes' in exchange;
    // const usdcBooks = hasMultiQuote
    //   ? await this.fetchOrderBooks(
    //       exchange,
    //       await (exchange as BinanceClient).getPairsForQuotes(['USDC']),
    //     )
    //   : [];
    // const usdcSummaries = usdcBooks.map((book) => book ? calculateDepthSummaries(book) : null);

    const aggregated = aggregateDepthSummaries(usdtSummaries, exchange.name);
    // const classicAggregated = aggregateClassicDepthSummaries(usdtBooks, usdtSummaries, exchange.name);
    // Combined USDT+USDC set uses the same cumulative depth logic as standard
    // const combinedAggregated = hasMultiQuote
    //   ? aggregateDepthSummaries([...usdtSummaries, ...usdcSummaries], `${exchange.name}_usdt_usdc`)
    //   : [];

    const rows = [
      ...aggregated.map((s) => ({ ...s, ts })),
      // ...classicAggregated.map((s) => ({ ...s, ts })),
      // ...combinedAggregated.map((s) => ({ ...s, ts })),
    ];
    await insertSnapshots(rows);

    const totalOk = [...usdtSummaries, ...usdcSummaries].filter(Boolean).length;
    const totalSkipped = usdtSummaries.length + usdcSummaries.length - totalOk;

    logger.info({
      event: 'cycle_complete',
      exchange: exchange.name,
      duration_ms: Date.now() - cycleStart,
      pairs_ok: totalOk,
      pairs_skipped: totalSkipped,
      cycle: this.cycleCount,
    });
  }
}
