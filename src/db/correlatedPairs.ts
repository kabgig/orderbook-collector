import { sql } from './client.js';

// Returns the list of Binance symbols whose BTC correlation is strictly positive.
// Pairs missing from public.correlations are excluded by definition (no row -> no result).
// Stablecoin pairs are already excluded upstream because the correlation universe is built
// from getPairsForQuotes(['USDT']) minus stables — so they never enter the correlations table.
export async function getCorrelatedSymbols(): Promise<string[]> {
  const rows = await sql<{ symbol: string }[]>`
    SELECT symbol
    FROM public.correlations
    WHERE correlation > 0
  `;
  return rows.map((r) => r.symbol);
}
