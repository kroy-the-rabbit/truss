// Supervises port-forwards that run inside trussd. Pure logic: the daemon API,
// the current daemon epoch and randomness are injected so this can be unit
// tested without Electron, HTTP or a real daemon.
//
// Policy (one place, main process):
// - the daemon never restarts a broken forward; it reports status "error"
// - a forward that was running gets up to PORT_FORWARD_MAX_RESTARTS restarts
//   with backoff; one that never ran is an error immediately
// - user stop and vault lock clear `wanted` and never restart
// - a new daemon epoch (daemon restarted: its forwards are gone) re-starts the
//   forwards the user still wants; so does system resume

import { Backoff } from './backoff';
import {
  decidePortForwardExit,
  derivePortForwardMessage,
  findPortForwardMatch,
  PORT_FORWARD_MAX_RESTARTS,
  PortForwardSpec,
  PortForwardStatus,
} from './portForwardLogic';

/** A forward as reported by trussd (GET /api/portforward). */
export interface DaemonForward {
  id: string;
  context: string;
  namespace: string;
  kind: 'pod' | 'service';
  name: string;
  remote_port: number | string;
  pod: string;
  pod_port: number;
  address: string;
  local_port: number;
  status: PortForwardStatus;
  last_error?: string;
  connection_error?: string;
  connections: number;
  total_connections: number;
  started_at: string;
  stopped_at?: string;
}

export interface DaemonForwardRequest {
  context: string;
  namespace: string;
  kind: 'pod' | 'service';
  name: string;
  remote_port: number | string;
  local_port: number;
}

export interface PortForwardApi {
  start(req: DaemonForwardRequest): Promise<DaemonForward>;
  stop(id: string): Promise<void>;
  list(): Promise<DaemonForward[]>;
}

/** Error from the daemon API; `status` is the HTTP status when there was one. */
export class PortForwardApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'PortForwardApiError';
  }
}

/** Renderer-facing record (the IPC contract of port-forward-list/start). */
export interface PortForwardView extends PortForwardSpec {
  id: string;
  status: PortForwardStatus;
  startedAt: string;
  stoppedAt?: string;
  message?: string;
  output: string;
  connections: number;
  pod?: string;
}

interface PortForwardRecord extends PortForwardView {
  /**
   * Context the daemon resolved on first start. Restarts use it so an empty
   * context ("active") can never drift to a different cluster later.
   */
  resolvedContext?: string;
  lastError?: string;
  lastConnError?: string;
  daemonId?: string;
  daemonEpoch?: number;
  launching: boolean;
  awaitingUnlock: boolean;
  wanted: boolean;
  everRunning: boolean;
  restartAttempts: number;
  restartPending: boolean;
  restartTimer?: ReturnType<typeof setTimeout>;
  runningSince?: number;
}

export interface PortForwardSupervisorOptions {
  api: PortForwardApi;
  /** Current daemon epoch (bumps every time a new trussd becomes ready). */
  getEpoch: () => number;
  pollIntervalMs?: number;
  healthyResetMs?: number;
  random?: () => number;
  now?: () => number;
}

const OUTPUT_LIMIT = 64_000;

function isLockedError(err: unknown): boolean {
  if (err instanceof PortForwardApiError && err.status === 409) return true;
  return String((err as Error)?.message ?? err).toLowerCase().includes('store is locked');
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

function clock(ms: number): string {
  // 24-hour local time, HH:MM:SS.
  return new Date(ms).toTimeString().slice(0, 8);
}

export class PortForwardSupervisor {
  private readonly records = new Map<string, PortForwardRecord>();
  private readonly backoffs = new Map<string, Backoff>();
  private locked = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private seq = 0;
  private readonly pollIntervalMs: number;
  private readonly healthyResetMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: PortForwardSupervisorOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.healthyResetMs = opts.healthyResetMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  list(): PortForwardView[] {
    return Array.from(this.records.values()).map((r) => this.view(r));
  }

  get(id: string): PortForwardView | undefined {
    const rec = this.records.get(id);
    return rec ? this.view(rec) : undefined;
  }

  isLocked(): boolean {
    return this.locked;
  }

  /** Start a forward. Resolution/bind errors from the daemon are thrown. */
  async start(spec: PortForwardSpec): Promise<PortForwardView> {
    if (this.locked) throw new Error('Store is locked; unlock before starting a port-forward');
    const match = findPortForwardMatch(this.records.values(), spec);
    if (match?.kind === 'duplicate') return this.view(match.record);
    if (match?.kind === 'port-conflict') {
      throw new Error(`Local port ${spec.localPort} is already used by another port-forward`);
    }
    // Older dead records for the same local port must not be revived later.
    for (const r of this.records.values()) {
      if (r.localPort === spec.localPort) this.cancel(r);
    }

    this.seq += 1;
    const id = `${this.now()}-${this.seq}-${Math.random().toString(36).slice(2, 8)}`;
    const rec: PortForwardRecord = {
      ...spec,
      id,
      status: 'starting',
      startedAt: new Date(this.now()).toISOString(),
      output: '',
      connections: 0,
      launching: false,
      awaitingUnlock: false,
      wanted: true,
      everRunning: false,
      restartAttempts: 0,
      restartPending: false,
    };
    this.records.set(id, rec);
    const err = await this.launch(rec, true);
    if (err) {
      this.records.delete(id);
      throw new Error(derivePortForwardMessage(errorText(err)));
    }
    return this.view(rec);
  }

  /** User stop: never restarts. */
  async stop(id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.cancel(rec);
    const daemonId = rec.daemonId;
    rec.daemonId = undefined;
    rec.status = 'stopped';
    rec.stoppedAt = new Date(this.now()).toISOString();
    rec.message = 'Stopped';
    rec.connections = 0;
    this.log(rec, 'Stopped by user');
    if (daemonId) await this.opts.api.stop(daemonId).catch(() => {});
    return true;
  }

  /** Vault locked: stop everything; nothing is restarted on unlock. */
  lock(): void {
    this.locked = true;
    for (const rec of this.records.values()) {
      const wasActive = rec.status === 'running' || rec.status === 'starting' || rec.restartPending;
      this.cancel(rec);
      const daemonId = rec.daemonId;
      rec.daemonId = undefined;
      if (daemonId) void this.opts.api.stop(daemonId).catch(() => {});
      if (wasActive) {
        rec.status = 'stopped';
        rec.stoppedAt = new Date(this.now()).toISOString();
        rec.message = 'Stopped: store locked';
        rec.connections = 0;
        this.log(rec, 'Stopped: store locked');
      }
    }
  }

  unlock(): void {
    this.locked = false;
    for (const rec of this.records.values()) {
      if (rec.awaitingUnlock && rec.wanted) void this.launch(rec, false);
    }
  }

  /** Daemon supervisor state change. A new epoch means a fresh daemon. */
  onDaemonState(state: { status: string; epoch: number }): void {
    if (state.status !== 'ready') return;
    for (const rec of this.records.values()) {
      if (!rec.wanted || this.locked || rec.launching || rec.restartPending) continue;
      const stale = rec.daemonId !== undefined && rec.daemonEpoch !== state.epoch;
      if (!stale && !rec.awaitingUnlock) continue;
      rec.daemonId = undefined;
      if (stale) {
        rec.message = 'Daemon restarted; reconnecting';
        this.log(rec, 'Daemon restarted; reconnecting');
      }
      void this.launch(rec, false);
    }
  }

  /** After sleep/screen unlock: re-check daemon state and revive dead forwards. */
  resume(): void {
    if (this.locked) return;
    void this.poll();
    for (const rec of this.records.values()) {
      if (!rec.wanted || !rec.everRunning || rec.daemonId || rec.launching) continue;
      if (rec.restartTimer) clearTimeout(rec.restartTimer);
      rec.restartTimer = undefined;
      rec.restartPending = false;
      rec.restartAttempts = 0;
      this.backoffs.get(rec.id)?.reset();
      rec.message = 'Reconnecting after resume';
      void this.launch(rec, false);
    }
  }

  /** App quit: drop timers. The daemon is stopped separately. */
  shutdown(): void {
    for (const rec of this.records.values()) this.cancel(rec);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.records.clear();
  }

  /** One poll of GET /api/portforward. Exposed for tests. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const epoch = this.opts.getEpoch();
      // Only judge forwards that existed before the list request went out.
      const expected = new Map<string, PortForwardRecord>();
      for (const rec of this.records.values()) {
        if (rec.daemonId && rec.daemonEpoch === epoch) expected.set(rec.daemonId, rec);
      }
      if (expected.size === 0) return;
      let forwards: DaemonForward[];
      try {
        forwards = await this.opts.api.list();
      } catch {
        return; // daemon unreachable; the daemon supervisor handles restarts
      }
      if (this.opts.getEpoch() !== epoch) return;
      const byId = new Map(forwards.map((f) => [f.id, f]));
      for (const [daemonId, rec] of expected) {
        if (rec.daemonId !== daemonId) continue; // changed while we waited
        const df = byId.get(daemonId);
        if (!df) {
          // trussd dropped it itself (lock, profile switch, context deleted).
          this.cancel(rec);
          rec.daemonId = undefined;
          rec.status = 'stopped';
          rec.stoppedAt = new Date(this.now()).toISOString();
          rec.message = 'Stopped by the daemon (store locked, profile switched or context removed)';
          rec.connections = 0;
          this.log(rec, rec.message);
          continue;
        }
        this.apply(rec, df);
      }
    } finally {
      this.polling = false;
      this.schedulePoll();
    }
  }

  // --- internals ------------------------------------------------------------

  private view(rec: PortForwardRecord): PortForwardView {
    return {
      id: rec.id,
      context: rec.context,
      namespace: rec.namespace,
      targetType: rec.targetType,
      targetName: rec.targetName,
      localPort: rec.localPort,
      targetPort: rec.targetPort,
      status: rec.status,
      startedAt: rec.startedAt,
      stoppedAt: rec.stoppedAt,
      message: rec.message,
      output: rec.output,
      connections: rec.connections,
      pod: rec.pod,
    };
  }

  private log(rec: PortForwardRecord, line: string): void {
    const out = `${rec.output}[${clock(this.now())}] ${line}\n`;
    rec.output = out.length > OUTPUT_LIMIT ? out.slice(out.length - OUTPUT_LIMIT) : out;
  }

  private cancel(rec: PortForwardRecord): void {
    rec.wanted = false;
    rec.awaitingUnlock = false;
    if (rec.restartTimer) clearTimeout(rec.restartTimer);
    rec.restartTimer = undefined;
    rec.restartPending = false;
    this.backoffs.delete(rec.id);
  }

  /**
   * Ask trussd to start the forward. Returns the error for an initial start
   * (so the caller can throw it); later attempts route errors into the
   * supervision policy instead.
   */
  private async launch(rec: PortForwardRecord, initial: boolean): Promise<unknown> {
    if (!rec.wanted || this.locked) return null;
    rec.launching = true;
    rec.awaitingUnlock = false;
    rec.status = 'starting';
    rec.stoppedAt = undefined;
    const epoch = this.opts.getEpoch();
    let df: DaemonForward;
    try {
      df = await this.opts.api.start({
        context: rec.resolvedContext || rec.context,
        namespace: rec.namespace,
        kind: rec.targetType,
        name: rec.targetName,
        remote_port: rec.targetPort,
        local_port: rec.localPort,
      });
    } catch (err) {
      rec.launching = false;
      if (initial) return err;
      if (!rec.wanted || this.locked) return null;
      if (isLockedError(err)) {
        rec.awaitingUnlock = true;
        rec.message = 'Waiting for the store to be unlocked';
        return null;
      }
      this.fail(rec, errorText(err));
      return null;
    }
    rec.launching = false;
    if (!rec.wanted || this.locked) {
      void this.opts.api.stop(df.id).catch(() => {});
      return null;
    }
    if (this.opts.getEpoch() !== epoch) {
      // The daemon restarted while we were starting; that forward is gone.
      void this.launch(rec, false);
      return null;
    }
    rec.daemonId = df.id;
    rec.daemonEpoch = epoch;
    if (df.context) rec.resolvedContext = df.context;
    rec.localPort = df.local_port || rec.localPort;
    rec.pod = df.pod;
    rec.lastConnError = undefined;
    this.log(rec, `Connecting ${df.address}:${df.local_port} -> ${df.kind}/${df.name} (pod ${df.pod}:${df.pod_port})`);
    this.apply(rec, df);
    this.schedulePoll();
    return null;
  }

  private apply(rec: PortForwardRecord, df: DaemonForward): void {
    rec.connections = df.connections ?? 0;
    if (df.connection_error && df.connection_error !== rec.lastConnError) {
      rec.lastConnError = df.connection_error;
      rec.lastError = derivePortForwardMessage(df.connection_error);
      this.log(rec, df.connection_error);
    }
    switch (df.status) {
      case 'running':
        if (rec.status !== 'running') {
          rec.status = 'running';
          rec.everRunning = true;
          rec.runningSince = this.now();
          rec.message = rec.restartAttempts > 0 ? 'Forwarding (reconnected)' : 'Forwarding';
          this.log(rec, `Forwarding from ${df.address}:${df.local_port} -> ${df.pod_port}`);
        }
        return;
      case 'starting':
        rec.status = 'starting';
        return;
      default:
        this.fail(rec, df.last_error || 'Port-forward stopped');
    }
  }

  private fail(rec: PortForwardRecord, reason: string): void {
    const daemonId = rec.daemonId;
    rec.daemonId = undefined;
    if (daemonId) void this.opts.api.stop(daemonId).catch(() => {});
    rec.connections = 0;
    rec.lastError = reason;
    rec.stoppedAt = new Date(this.now()).toISOString();
    this.log(rec, reason);
    // A forward that ran healthily for a while gets a fresh restart budget.
    if (rec.runningSince !== undefined && this.now() - rec.runningSince >= this.healthyResetMs) {
      rec.restartAttempts = 0;
      this.backoffs.get(rec.id)?.reset();
    }
    rec.runningSince = undefined;
    const decision = decidePortForwardExit({
      wanted: rec.wanted,
      everRunning: rec.everRunning,
      restartAttempts: rec.restartAttempts,
    });
    if (decision === 'stopped') {
      rec.status = 'stopped';
      return;
    }
    if (decision === 'error') {
      rec.status = 'error';
      rec.message = derivePortForwardMessage(reason);
      if (!rec.everRunning) rec.wanted = false;
      return;
    }
    this.scheduleRestart(rec);
  }

  private scheduleRestart(rec: PortForwardRecord): void {
    let backoff = this.backoffs.get(rec.id);
    if (!backoff) {
      backoff = new Backoff(this.healthyResetMs, this.opts.random);
      this.backoffs.set(rec.id, backoff);
    }
    const delay = backoff.next();
    rec.restartAttempts += 1;
    rec.status = 'starting';
    rec.restartPending = true;
    rec.message = `Reconnecting (attempt ${rec.restartAttempts}/${PORT_FORWARD_MAX_RESTARTS})`;
    this.log(rec, rec.message);
    rec.restartTimer = setTimeout(() => {
      rec.restartTimer = undefined;
      rec.restartPending = false;
      if (!rec.wanted || this.locked) {
        rec.status = 'stopped';
        return;
      }
      void this.launch(rec, false);
    }, delay);
  }

  private schedulePoll(): void {
    if (this.pollTimer) return;
    const active = Array.from(this.records.values()).some((r) => r.daemonId !== undefined);
    if (!active) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, this.pollIntervalMs);
  }
}
