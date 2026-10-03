import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Backoff, backoffDelay } from '../../src/main/backoff';
import { DaemonHandle, DaemonStatePayload, DaemonSupervisor } from '../../src/main/daemonSupervisor';

describe('backoffDelay', () => {
  it('stays within full-jitter bounds', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const ceiling = Math.min(30_000, 500 * 2 ** attempt);
      expect(backoffDelay(attempt, () => 0)).toBe(0);
      const max = backoffDelay(attempt, () => 0.999999);
      expect(max).toBeLessThanOrEqual(ceiling);
      expect(max).toBeGreaterThanOrEqual(ceiling - 1);
      for (let i = 0; i < 50; i++) {
        const d = backoffDelay(attempt);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('caps at 30s even for huge attempts', () => {
    expect(backoffDelay(10_000, () => 1)).toBe(30_000);
    expect(backoffDelay(5, () => 0.5)).toBe(8_000);
  });
});

describe('Backoff', () => {
  it('increments attempts and resets after 60s of healthy running', () => {
    const b = new Backoff(60_000, () => 1);
    expect(b.next()).toBe(500);
    expect(b.next()).toBe(1000);
    expect(b.next()).toBe(2000);
    expect(b.attempt).toBe(3);
    b.markHealthy(0);
    b.markHealthy(59_999);
    expect(b.attempt).toBe(3);
    b.markHealthy(60_000);
    expect(b.attempt).toBe(0);
    expect(b.next()).toBe(500);
  });

  it('unhealthy interrupts the reset clock', () => {
    const b = new Backoff(60_000, () => 1);
    b.next();
    b.markHealthy(0);
    b.markUnhealthy();
    b.markHealthy(50_000);
    b.markHealthy(100_000);
    expect(b.attempt).toBe(1);
    b.markHealthy(110_000);
    expect(b.attempt).toBe(0);
  });
});

interface FakeHandle extends DaemonHandle<{ port: number }> {
  exit(reason?: string): void;
  killed: boolean;
}

function makeHandle(port: number): FakeHandle {
  const listeners: Array<(r: string) => void> = [];
  let exited: string | null = null;
  const h: FakeHandle = {
    config: { port },
    killed: false,
    onExit(cb) {
      if (exited !== null) cb(exited);
      else listeners.push(cb);
    },
    kill() {
      h.killed = true;
    },
    exit(reason = 'code 1') {
      exited = reason;
      for (const cb of listeners.splice(0)) cb(reason);
    },
  };
  return h;
}

function setup(opts: { pingOk?: () => boolean; launchFails?: () => boolean } = {}) {
  const states: DaemonStatePayload[] = [];
  const handles: FakeHandle[] = [];
  let port = 1000;
  const launch = vi.fn(async () => {
    if (opts.launchFails?.()) throw new Error('boom');
    const h = makeHandle(++port);
    handles.push(h);
    return h;
  });
  const ping = vi.fn(async () => {
    if (opts.pingOk && !opts.pingOk()) throw new Error('no answer');
  });
  const sup = new DaemonSupervisor<{ port: number }>({
    launch,
    ping,
    onState: (s) => states.push(s),
    random: () => 0.5,
    now: () => Date.now(),
  });
  return { sup, states, handles, launch, ping };
}

describe('DaemonSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts ready with epoch 1 and exposes the config', async () => {
    const { sup, states } = setup();
    await sup.start();
    expect(states.map((s) => s.status)).toEqual(['ready']);
    expect(sup.getState()).toEqual({ status: 'ready', epoch: 1 });
    expect(sup.getConfig()).toEqual({ port: 1001 });
  });

  it('crash → restarting → ready with epoch+1 and new config', async () => {
    const { sup, states, handles } = setup();
    await sup.start();
    handles[0].exit('signal SIGKILL');
    expect(sup.getState().status).toBe('restarting');
    expect(sup.getState().error).toMatch(/exited unexpectedly/);
    expect(sup.getConfig()).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sup.getState()).toEqual({ status: 'ready', epoch: 2 });
    expect(sup.getConfig()).toEqual({ port: 1002 });
    expect(states.map((s) => s.status)).toEqual(['ready', 'restarting', 'ready']);
  });

  it('intentional stop never restarts', async () => {
    const { sup, handles, launch } = setup();
    await sup.start();
    sup.stop();
    expect(handles[0].killed).toBe(true);
    handles[0].exit('signal SIGTERM');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(sup.getState().status).toBe('ready');
  });

  it('restarts after 3 consecutive failed pings', async () => {
    let healthy = true;
    const { sup, handles, launch, ping } = setup({ pingOk: () => healthy });
    await sup.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ping).toHaveBeenCalledTimes(1);
    healthy = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sup.getState().status).toBe('ready');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sup.getState().status).toBe('restarting');
    expect(handles[0].killed).toBe(true);
    healthy = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(sup.getState()).toEqual({ status: 'ready', epoch: 2 });
  });

  it('a successful ping resets the failure counter', async () => {
    const results = [false, false, true, false, false, true];
    const { sup, launch } = setup({ pingOk: () => results.shift() ?? true });
    await sup.start();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(sup.getState().status).toBe('ready');
  });

  it('initial launch failure keeps retrying and eventually reports failed, then recovers', async () => {
    let failing = true;
    const { sup, launch } = setup({ launchFails: () => failing });
    await sup.start();
    expect(sup.getState().status).toBe('restarting');
    expect(sup.getConfig()).toBeNull();
    await vi.advanceTimersByTimeAsync(5 * 30_000);
    expect(sup.getState().status).toBe('failed');
    failing = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sup.getState()).toEqual({ status: 'ready', epoch: 1 });
    expect(launch.mock.calls.length).toBeGreaterThan(5);
  });

  it('checkNow pings immediately when ready and retries a pending restart', async () => {
    const { sup, handles, launch, ping } = setup();
    await sup.start();
    sup.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(ping).toHaveBeenCalledTimes(1);

    handles[0].exit();
    expect(sup.getState().status).toBe('restarting');
    sup.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(sup.getState()).toEqual({ status: 'ready', epoch: 2 });
  });

  it('a stale handle exiting after restart is ignored', async () => {
    const { sup, handles, launch } = setup();
    await sup.start();
    handles[0].exit();
    await vi.advanceTimersByTimeAsync(30_000);
    handles[0].exit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(sup.getState()).toEqual({ status: 'ready', epoch: 2 });
  });
});
