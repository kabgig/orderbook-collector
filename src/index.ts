import { BinanceClient } from './exchanges/binance/client.js';
import { OKXClient } from './exchanges/okx/client.js';
import { BybitClient } from './exchanges/bybit/client.js';
import { CollectionScheduler } from './scheduler/index.js';
import { sql } from './db/client.js';
import { logger } from './utils/logger.js';
import { config } from './config.js';

async function main() {
  logger.info('orderbook-collector starting...');

  // Log which Neon project/host this process actually connects to.
  // Parsed from the DATABASE_URL the schema resolved (after env+`.env` merge),
  // so a stale shell-exported URL becomes obvious instead of silently winning.
  const urlHost = (() => {
    try { return new URL(config.DATABASE_URL).host; } catch { return '<unparseable>'; }
  })();
  await sql`SELECT 1`;
  const dbInfo = await sql<{ db: string; user: string }[]>`SELECT current_database() AS db, current_user AS user`;
  logger.info({ url_host: urlHost, db: dbInfo[0]?.db, user: dbInfo[0]?.user }, 'Database connected ✓');

  const dataset = config.DATASET;
  const client = dataset.startsWith('okx') ? new OKXClient()
    : dataset.startsWith('bybit') ? new BybitClient()
    : new BinanceClient();

  const exchanges = [client];

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
