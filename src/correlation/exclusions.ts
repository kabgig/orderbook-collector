// Symbol-level filters for the correlation universe.
// Stablecoin exclusion is already handled by BinanceClient.getPairsForQuotes() via the
// shared STABLECOIN_BASES set — we don't duplicate that here.
// This file adds the additional filter for leveraged tokens (UP/DOWN/BULL/BEAR),
// which Binance delisted in 2022 but the regex remains as a defensive guard.

// Quote asset we correlate against (BTC is the reference, /USDT is the quote universe).
export const QUOTE_ASSET = 'USDT';
export const BTC_REFERENCE_SYMBOL = 'BTCUSDT';

// Regex matches "*UPUSDT", "*DOWNUSDT", "*BULLUSDT", "*BEARUSDT" — Binance's
// historic leveraged-token naming convention. Anchored to end-of-symbol.
const LEVERAGED_TOKEN_RE = /(?:UP|DOWN|BULL|BEAR)USDT$/;

// True if the symbol is a Binance leveraged token (should be excluded from correlations).
// Note: wrapped-BTC variants (WBTC, BTCB) are intentionally NOT excluded — per spec,
// all valid pairs stay in the table even if correlation ~1.0 (consumed by downstream indicators).
export function isLeveragedToken(symbol: string): boolean {
  return LEVERAGED_TOKEN_RE.test(symbol);
}
