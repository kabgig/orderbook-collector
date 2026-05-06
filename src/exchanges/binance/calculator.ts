import type { OrderBook, DepthSummary, DepthLevel } from '../../types/shared.js';
import { DEPTH_LEVELS } from '../../types/shared.js';

// Mid price from best bid and best ask
export function getMidPrice(
  bids: [string, string][],
  asks: [string, string][]
): number {
  if (bids.length === 0) throw new Error('bids array is empty');
  if (asks.length === 0) throw new Error('asks array is empty');
  return (parseFloat(bids[0]![0]) + parseFloat(asks[0]![0])) / 2;
}

// Sum USD value of orders within a price range [minPrice, maxPrice] inclusive
export function sumOrderValue(
  orders: [string, string][],
  minPrice: number,
  maxPrice: number
): number {
  let total = 0;
  for (const [priceStr, qtyStr] of orders) {
    const price = parseFloat(priceStr);
    if (price >= minPrice && price <= maxPrice) {
      total += price * parseFloat(qtyStr);
    }
  }
  return total;
}

// Calculate depth summary for one order book across all depth levels
// Returns null if the pair should be skipped (empty sides, wide spread)
export function calculateDepthSummaries(
  orderBook: OrderBook,
  depthLevels: readonly DepthLevel[] = DEPTH_LEVELS
): DepthSummary[] | null {
  const { bids, asks, exchange } = orderBook;

  if (bids.length === 0 || asks.length === 0) return null;

  const bestBid = parseFloat(bids[0]![0]);
  const bestAsk = parseFloat(asks[0]![0]);
  const midPrice = (bestBid + bestAsk) / 2;

  // Skip if spread > 5%
  if (Math.abs(bestAsk - bestBid) / midPrice > 0.05) return null;

  return depthLevels.map((depth_pct) => {
    const factor = depth_pct / 100;
    const bidMin = midPrice * (1 - factor);
    const askMax = midPrice * (1 + factor);

    return {
      depth_pct,
      total_bid: sumOrderValue(bids, bidMin, midPrice),
      total_ask: sumOrderValue(asks, midPrice, askMax),
      pair_count: 1,
      exchange,
    };
  });
}

// Aggregate summaries from all pairs into one total per depth level
export function aggregateDepthSummaries(
  allPairSummaries: Array<DepthSummary[] | null>,
  exchange: string,
  depthLevels: readonly DepthLevel[] = DEPTH_LEVELS
): DepthSummary[] {
  const valid = allPairSummaries.filter(
    (s): s is DepthSummary[] => s !== null
  );
  const pairCount = valid.length;

  return depthLevels.map((depth_pct) => {
    let totalBid = 0;
    let totalAsk = 0;

    for (const pairSummaries of valid) {
      const match = pairSummaries.find((s) => s.depth_pct === depth_pct);
      if (match) {
        totalBid += match.total_bid;
        totalAsk += match.total_ask;
      }
    }

    return {
      depth_pct,
      total_bid: totalBid,
      total_ask: totalAsk,
      pair_count: pairCount,
      exchange,
    };
  });
}
