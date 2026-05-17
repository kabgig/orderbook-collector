import { z } from 'zod';

// Load .env before reading process.env — no-op if file is absent (production)
try {
  process.loadEnvFile('.env');
} catch { /* ok — env vars already provided by the environment */ }

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Controls which dataset this instance collects — one instance per dataset
  DATASET: z.enum([
    'binance', 'binance_usdt_usdc', 'binance_classic',
    'okx', 'okx_usdt_usdc', 'okx_classic',
    'bybit', 'bybit_usdt_usdc', 'bybit_classic',
  ]),
  COLLECTION_INTERVAL_MS: z.coerce.number().default(60_000),
  BATCH_SIZE: z.coerce.number().default(80),
  BATCH_DELAY_MS: z.coerce.number().default(500),
  // Multi-instance coordination for the same dataset.
  // When true, this instance only fetches if at least COORDINATION_MIN_GAP_MS has
  // passed since the last successful claim by any instance (atomic, DB-enforced).
  // Each instance is dedicated to one DATASET, so a single boolean is enough.
  COORDINATED: z.coerce.boolean().default(false),
  COORDINATION_MIN_GAP_MS: z.coerce.number().default(60_000),
  COORDINATION_RETRY_MS: z.coerce.number().default(7_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BINANCE_BASE_URL: z.string().url().default('https://api.binance.com'),
  OKX_BASE_URL: z.string().url().default('https://www.okx.com'),
  BYBIT_BASE_URL: z.string().url().default('https://api.bybit.com'),
  // Enables the daily BTC-correlation update service on THIS instance only.
  // Set to true on exactly one Railway/VPS instance across the whole fleet; the DB-level
  // lock (dataset_fetch_locks) provides a second line of defence if accidentally enabled on >1.
  // Independent of DATASET — the correlation service always hits Binance regardless of which
  // exchange this instance aggregates, so OKX/Bybit instances are equally fine to host it.
  CORRELATION_UPDATES_ENABLED: z.coerce.boolean().default(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment config:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
