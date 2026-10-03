/**
 * Exponential backoff with "full jitter": the delay for attempt N is a uniform
 * random value in [0, min(cap, base * 2^N)). Spreads reconnect storms out
 * (e.g. every window reconnecting after a daemon restart) while still retrying
 * quickly after the first failure.
 */

export interface BackoffOptions {
  /** Upper bound of the first attempt's delay window. Default 500ms. */
  baseMs?: number;
  /** Maximum delay. Default 30s. */
  capMs?: number;
  /** Injectable RNG for tests; returns a value in [0, 1). */
  random?: () => number;
}

export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_CAP_MS = 30000;

/** Delay (ms) before retry number `attempt` (0-based). */
export function nextDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = Math.max(1, opts.baseMs ?? DEFAULT_BACKOFF_BASE_MS);
  const cap = Math.max(base, opts.capMs ?? DEFAULT_BACKOFF_CAP_MS);
  const n = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  // 2^n overflows to Infinity for huge n; Math.min clamps it to cap.
  const window = Math.min(cap, base * Math.pow(2, Math.min(n, 1024)));
  const r = (opts.random ?? Math.random)();
  return Math.floor(Math.min(Math.max(r, 0), 1) * window);
}

export interface BackoffOptionsWithStable extends BackoffOptions {
  /**
   * A connection that stayed up at least this long counts as healthy: the
   * next failure starts again from attempt 0. Default 30s.
   */
  stableMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface Backoff {
  /** Returns the delay for the next retry and advances the attempt counter. */
  next(): number;
  /** Start again from attempt 0. */
  reset(): void;
  /**
   * Record a successful connect. The attempt counter is reset on the next
   * `next()` call only if the connection lasted at least `stableMs`, so a
   * server that accepts and immediately drops does not cause a tight loop.
   */
  markConnected(): void;
  /** Number of retries handed out since the last reset. */
  readonly attempt: number;
}

export function createBackoff(opts: BackoffOptionsWithStable = {}): Backoff {
  const stableMs = opts.stableMs ?? 30000;
  const now = opts.now ?? Date.now;
  let attempt = 0;
  let connectedAt: number | null = null;

  return {
    next() {
      if (connectedAt !== null) {
        if (now() - connectedAt >= stableMs) attempt = 0;
        connectedAt = null;
      }
      const delay = nextDelay(attempt, opts);
      attempt++;
      return delay;
    },
    reset() {
      attempt = 0;
      connectedAt = null;
    },
    markConnected() {
      connectedAt = now();
    },
    get attempt() {
      return attempt;
    },
  };
}
