// Pure retry/backoff helpers shared by the daemon supervisor and the
// port-forward manager. No Electron or Node process imports so they can be
// unit tested directly.

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;

/**
 * Full-jitter exponential backoff: random(0, min(cap, base * 2^attempt)).
 * `attempt` is zero-based (0 for the first retry).
 */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  base = BACKOFF_BASE_MS,
  cap = BACKOFF_CAP_MS,
): number {
  const n = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  // 2^n overflows to Infinity for huge n; Math.min handles that.
  const ceiling = Math.min(cap, base * Math.pow(2, n));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.floor(r * ceiling);
}

/**
 * Tracks consecutive retry attempts. The attempt counter only resets once the
 * guarded thing has been healthy for `resetAfterMs` (a flapping process keeps
 * backing off instead of restarting at full speed forever).
 */
export class Backoff {
  private attemptCount = 0;
  private healthySince: number | null = null;

  constructor(
    private readonly resetAfterMs = 60_000,
    private readonly random: () => number = Math.random,
    private readonly base = BACKOFF_BASE_MS,
    private readonly cap = BACKOFF_CAP_MS,
  ) {}

  get attempt(): number {
    return this.attemptCount;
  }

  /** Delay for the next retry; increments the attempt counter. */
  next(): number {
    const delay = backoffDelay(this.attemptCount, this.random, this.base, this.cap);
    this.attemptCount += 1;
    this.healthySince = null;
    return delay;
  }

  /** Record that the guarded thing is healthy at time `now`. */
  markHealthy(now: number): void {
    if (this.healthySince === null) {
      this.healthySince = now;
      return;
    }
    if (now - this.healthySince >= this.resetAfterMs) {
      this.attemptCount = 0;
    }
  }

  /** Record that the guarded thing became unhealthy (stops the reset clock). */
  markUnhealthy(): void {
    this.healthySince = null;
  }

  reset(): void {
    this.attemptCount = 0;
    this.healthySince = null;
  }
}
