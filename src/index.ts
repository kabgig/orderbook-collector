import { BinanceClient } from './exchanges/binance/client.js';
import { CollectionScheduler } from './scheduler/index.js';
import { sql } from './db/client.js';
import { logger } from './utils/logger.js';

async function main() {
  logger.info('orderbook-collector starting...');

  // Verify DB connection before starting loop
  await sql`SELECT 1`;
  logger.info('Database connected ✓');

  const exchanges = [
    new BinanceClient(),
    // new BybitClient(),   ← add here later
    // new OKXClient(),     ← add here later
  ];

  const scheduler = new CollectionScheduler(exchanges);

  const shutdown = async () => {
    logger.info('Shutdown signal received');
    scheduler.stop();
    await sql.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await scheduler.start();
}

main().catch((err: unknown) => {
  console.error('Fatal error — collector crashed', err);
  process.exit(1);
});
