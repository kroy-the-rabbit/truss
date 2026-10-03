import { describe, expect, test } from 'vitest';
import { createBackoff, nextDelay } from '../../src/renderer/lib/backoff';

describe('nextDelay', () => {
  test('full jitter: uniform in [0, min(cap, base * 2^attempt))', () => {
    const max = () => 0.999999;
    expect(nextDelay(0, { random: max })).toBe(499);
    expect(nextDelay(1, { random: max })).toBe(999);
    expect(nextDelay(3, { random: max })).toBe(3999);
    expect(nextDelay(0, { random: () => 0 })).toBe(0);
    expect(nextDelay(2, { random: () => 0.5 })).toBe(1000);
  });

  test('is capped and handles huge or invalid attempts', () => {
    const max = () => 0.999999;
    expect(nextDelay(10, { random: max })).toBe(29999);
    expect(nextDelay(5000, { random: max })).toBe(29999);
    expect(nextDelay(Number.NaN, { random: max })).toBe(499);
    expect(nextDelay(-3, { random: max })).toBe(499);
    expect(nextDelay(4, { baseMs: 100, capMs: 1000, random: max })).toBe(999);
  });

  test('default random stays within the window', () => {
    for (let i = 0; i < 200; i++) {
      const d = nextDelay(2);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(2000);
    }
  });
});

describe('createBackoff', () => {
  test('advances and resets', () => {
    const b = createBackoff({ random: () => 0.999999 });
    expect(b.next()).toBe(499);
    expect(b.next()).toBe(999);
    expect(b.next()).toBe(1999);
    expect(b.attempt).toBe(3);
    b.reset();
    expect(b.attempt).toBe(0);
    expect(b.next()).toBe(499);
  });

  test('resets only after a connection that stayed up for stableMs', () => {
    let now = 0;
    const b = createBackoff({ random: () => 0.999999, stableMs: 30000, now: () => now });
    b.next();
    b.next();
    b.next();
    // Connected, but dropped after 5s: keep backing off.
    b.markConnected();
    now += 5000;
    expect(b.next()).toBe(3999);
    // Connected and stable for 30s: start over.
    b.markConnected();
    now += 30000;
    expect(b.next()).toBe(499);
    expect(b.attempt).toBe(1);
  });
});
