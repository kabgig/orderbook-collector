import { BinanceClient } from './exchanges/binance/client.js';
import { OKXClient } from './exchanges/okx/client.js';
import { BybitClient } from './exchanges/bybit/client.js';
import { CollectionScheduler } from './scheduler/index.js';
import { startCorrelationService, stopCorrelationService } from './correlation/scheduler.js';
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

  // Log the public egress IP of this instance — so we can verify each Railway/VPS
  // deployment uses a distinct IP (otherwise Binance per-IP rate limits collapse all instances).
  // Fire-and-forget with a short timeout so a flaky IP-echo service can't block startup.
  void logEgressIp();

  const dataset = config.DATASET;
  const client = dataset.startsWith('okx') ? new OKXClient()
    : dataset.startsWith('bybit') ? new BybitClient()
    : new BinanceClient();

  const exchanges = [client];

  const scheduler = new CollectionScheduler(exchanges);

  // Optionally start the correlation update service in parallel.
  // Fire-and-forget — fully isolated from the aggregation scheduler; failures here
  // never affect orderbook collection. Enable on exactly one instance fleet-wide.
  if (config.CORRELATION_UPDATES_ENABLED) {
    logger.info('CORRELATION_UPDATES_ENABLED=true — launching correlation service in parallel');
    void startCorrelationService().catch((err: unknown) => {
      logger.error({ err }, 'correlation service crashed (aggregation continues)');
    });
  } else {
    logger.info('CORRELATION_UPDATES_ENABLED=false — correlation service not running on this instance');
  }

  const shutdown = async () => {
    logger.info('Shutdown signal received');
    scheduler.stop();
    stopCorrelationService();
    await sql.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await scheduler.start();
}

async function logEgressIp(): Promise<void> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 5000);
  try {
    // Two-endpoint race so a single provider outage doesn't blank the log
    const res = await Promise.any([
      fetch('https://api.ipify.org?format=json', { signal: ac.signal }).then((r) => r.json() as Promise<{ ip: string }>),
      fetch('https://ifconfig.me/all.json', { signal: ac.signal }).then((r) => r.json() as Promise<{ ip_addr: string }>),
    ]);
    const ip = (res as { ip?: string; ip_addr?: string }).ip ?? (res as { ip_addr?: string }).ip_addr;
    logger.info({ egress_ip: ip, dataset: config.DATASET }, `Egress IP: ${ip} (dataset=${config.DATASET})`);
  } catch (err) {
    logger.warn({ err }, 'Could not determine egress IP (continuing anyway)');
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error — collector crashed', err);
  process.exit(1);
});
