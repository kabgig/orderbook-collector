import { sleep } from './sleep.js';

export class RateLimiter {
  private usedWeight = 0;
  private windowStart = Date.now();
  private readonly safeLimit: number;

  constructor(
    private readonly maxWeight = 6000,
    safetyBuffer = 0.9
  ) {
    this.safeLimit = Math.floor(maxWeight * safetyBuffer);
  }

  syncFromHeader(headerValue: string | null): void {
    if (!headerValue) return;
    const parsed = parseInt(headerValue, 10);
    if (!isNaN(parsed)) {
      this.resetIfNewWindow();
      this.usedWeight = parsed;
    }
  }

  async acquire(weight: number): Promise<void> {
    this.resetIfNewWindow();
    if (this.usedWeight + weight > this.safeLimit) {
      // Wait until the next 60s window resets
      const msUntilReset = 60_000 - (Date.now() - this.windowStart);
      await sleep(Math.max(msUntilReset, 0) + 100);
      this.resetIfNewWindow();
    }
    this.usedWeight += weight;
  }

  private resetIfNewWindow(): void {
    if (Date.now() > this.windowStart + 60_000) {
      this.usedWeight = 0;
      this.windowStart = Date.now();
    }
  }
}
