// Daemon supervisor state machine. Spawning and health pings are injected so
// the restart/backoff logic can be unit tested without a real trussd.

import { Backoff } from './backoff';

export type DaemonStatus = 'starting' | 'ready' | 'restarting' | 'failed';

export interface DaemonStatePayload {
  status: DaemonStatus;
  epoch: number;
  error?: string;
}

export interface DaemonHandle<C> {
  config: C;
  /** Register an exit listener. Called immediately if the process already exited. */
  onExit(cb: (reason: string) => void): void;
  /** Terminate the process (intentional; must not trigger a restart by itself). */
  kill(): void;
}

export interface DaemonSupervisorOptions<C> {
  launch: () => Promise<DaemonHandle<C>>;
  ping: (config: C, timeoutMs: number) => Promise<void>;
  onState?: (state: DaemonStatePayload, config: C | null) => void;
  healthIntervalMs?: number;
  pingTimeoutMs?: number;
  maxPingFailures?: number;
  healthyResetMs?: number;
  /** Consecutive failed (re)starts after which the status becomes 'failed'. Retries continue. */
  failedAfterAttempts?: number;
  random?: () => number;
  now?: () => number;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class DaemonSupervisor<C> {
  private readonly opts: Required<Omit<DaemonSupervisorOptions<C>, 'onState'>> & Pick<DaemonSupervisorOptions<C>, 'onState'>;
  private readonly backoff: Backoff;
  private state: DaemonStatePayload = { status: 'starting', epoch: 0 };
  private handle: DaemonHandle<C> | null = null;
  private stopped = false;
  private launching = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInFlight = false;
  private pingFailures = 0;
  private failedStarts = 0;

  constructor(opts: DaemonSupervisorOptions<C>) {
    this.opts = {
      healthIntervalMs: 10_000,
      pingTimeoutMs: 2_000,
      maxPingFailures: 3,
      healthyResetMs: 60_000,
      failedAfterAttempts: 5,
      random: Math.random,
      now: Date.now,
      ...opts,
    };
    this.backoff = new Backoff(this.opts.healthyResetMs, this.opts.random);
  }

  getState(): DaemonStatePayload {
    return { ...this.state };
  }

  getConfig(): C | null {
    return this.state.status === 'ready' && this.handle ? this.handle.config : null;
  }

  /** Start supervising. Resolves once the first launch attempt settles (success or failure). */
  async start(): Promise<void> {
    this.stopped = false;
    this.setState({ status: 'starting', epoch: this.state.epoch });
    await this.launchOnce();
  }

  /** Intentional stop: kills the daemon and never restarts it. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const h = this.handle;
    this.handle = null;
    if (h) h.kill();
  }

  /** Immediate health check (e.g. after system resume). Retries a pending restart now. */
  checkNow(): void {
    if (this.stopped) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      void this.launchOnce();
      return;
    }
    if (this.state.status === 'ready' && this.handle) {
      if (this.healthTimer) {
        clearTimeout(this.healthTimer);
        this.healthTimer = null;
      }
      void this.runHealthCheck();
    }
  }

  private setState(next: DaemonStatePayload): void {
    const prev = this.state;
    this.state = next;
    if (prev.status === next.status && prev.epoch === next.epoch && prev.error === next.error) return;
    this.opts.onState?.(this.getState(), this.getConfig());
  }

  private clearTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.restartTimer = null;
    this.healthTimer = null;
  }

  private async launchOnce(): Promise<void> {
    if (this.stopped || this.launching) return;
    this.launching = true;
    let handle: DaemonHandle<C>;
    try {
      handle = await this.opts.launch();
    } catch (err) {
      this.launching = false;
      this.failedStarts += 1;
      this.scheduleRestart(`Daemon failed to start: ${errText(err)}`);
      return;
    }
    this.launching = false;
    if (this.stopped) {
      handle.kill();
      return;
    }
    this.handle = handle;
    this.failedStarts = 0;
    this.pingFailures = 0;
    this.backoff.markHealthy(this.opts.now());
    handle.onExit((reason) => {
      if (this.handle !== handle || this.stopped) return;
      this.handle = null;
      this.scheduleRestart(`Daemon exited unexpectedly (${reason})`);
    });
    // The exit callback may have fired synchronously above.
    if (this.handle !== handle) return;
    this.setState({ status: 'ready', epoch: this.state.epoch + 1 });
    this.scheduleHealthCheck();
  }

  private scheduleRestart(error: string): void {
    if (this.stopped) return;
    this.clearTimers();
    this.backoff.markUnhealthy();
    const old = this.handle;
    this.handle = null;
    if (old) old.kill();
    const status = this.failedStarts >= this.opts.failedAfterAttempts ? 'failed' : 'restarting';
    this.setState({ status, epoch: this.state.epoch, error });
    const delay = this.backoff.next();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.launchOnce();
    }, delay);
  }

  private scheduleHealthCheck(): void {
    if (this.stopped || this.healthTimer) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      void this.runHealthCheck();
    }, this.opts.healthIntervalMs);
  }

  private async runHealthCheck(): Promise<void> {
    const handle = this.handle;
    if (this.stopped || !handle || this.pingInFlight) return;
    this.pingInFlight = true;
    let ok = true;
    let error = '';
    try {
      await this.opts.ping(handle.config, this.opts.pingTimeoutMs);
    } catch (err) {
      ok = false;
      error = errText(err);
    }
    this.pingInFlight = false;
    if (this.stopped || this.handle !== handle) return;
    if (ok) {
      this.pingFailures = 0;
      this.backoff.markHealthy(this.opts.now());
    } else {
      this.pingFailures += 1;
      if (this.pingFailures >= this.opts.maxPingFailures) {
        this.scheduleRestart(`Daemon health check failed ${this.pingFailures} times: ${error}`);
        return;
      }
    }
    this.scheduleHealthCheck();
  }
}
