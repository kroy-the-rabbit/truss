import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { QueryClient } from '@tanstack/react-query';
import { resetTransport } from '../api/client';
import { invalidateHelmViews, invalidateResourceViews } from './queries';

export type DaemonStatus = 'starting' | 'ready' | 'restarting' | 'failed';

export interface DaemonState {
  status: DaemonStatus;
  /** Bumped by the main process every time a new daemon process becomes current. */
  epoch: number;
  error?: string;
}

interface ConnectionStore {
  /** False when the main process does not expose daemon-state events (older build). */
  supported: boolean;
  daemon: DaemonState;
  /** Date.now() of the last system resume (0 = none since this window opened). */
  lastResumeAt: number;
  setDaemon: (daemon: DaemonState) => void;
  markResume: (at?: number) => void;
  reset: () => void;
}

const INITIAL_DAEMON: DaemonState = { status: 'starting', epoch: 0 };

export const useConnectionStore = create<ConnectionStore>((set) => ({
  supported: false,
  daemon: INITIAL_DAEMON,
  lastResumeAt: 0,
  setDaemon: (daemon) =>
    set((s) => {
      const prev = s.daemon;
      if (s.supported && prev.status === daemon.status && prev.epoch === daemon.epoch && prev.error === daemon.error) {
        return s;
      }
      return { supported: true, daemon: { ...daemon } };
    }),
  markResume: (at) => set({ lastResumeAt: at ?? Date.now() }),
  reset: () => set({ supported: false, daemon: INITIAL_DAEMON, lastResumeAt: 0 }),
}));

const VALID_STATUSES: ReadonlySet<string> = new Set(['starting', 'ready', 'restarting', 'failed']);

export function normalizeDaemonState(raw: unknown): DaemonState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<DaemonState>;
  if (typeof r.status !== 'string' || !VALID_STATUSES.has(r.status)) return null;
  return {
    status: r.status as DaemonStatus,
    epoch: typeof r.epoch === 'number' && Number.isFinite(r.epoch) ? r.epoch : 0,
    ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
  };
}

// ── Reactions ───────────────────────────────────────────────────────────────

export interface ConnectionSyncOptions {
  /** Main window only: re-run the read-only reconcile after a daemon restart. */
  onDaemonRestart?: () => void;
}

/** Refetch everything that came from the daemon: resources, Helm, health, ping. */
function invalidateDaemonData(qc: Pick<QueryClient, 'invalidateQueries'>) {
  invalidateResourceViews(qc);
  invalidateHelmViews(qc);
  void qc.invalidateQueries({ queryKey: ['contextHealth'] });
  void qc.invalidateQueries({ queryKey: ['ping'] });
}

/**
 * Applies one daemon-state report. Exported for tests. Returns the epoch to
 * remember. `prevEpoch` null means this is the first report this window saw.
 */
export function applyDaemonState(
  next: DaemonState,
  prevEpoch: number | null,
  prevStatus: DaemonStatus | null,
  qc: Pick<QueryClient, 'invalidateQueries'>,
  opts: ConnectionSyncOptions = {},
): number {
  useConnectionStore.getState().setDaemon(next);
  const epochChanged = prevEpoch !== null && next.epoch !== prevEpoch;
  const becameReady = next.status === 'ready' && prevStatus !== null && prevStatus !== 'ready';
  if (epochChanged || becameReady) {
    // The port and token may have changed: rebuild the transport on next call.
    resetTransport();
  }
  if (next.status === 'ready' && (epochChanged || becameReady)) {
    invalidateDaemonData(qc);
    opts.onDaemonRestart?.();
  }
  return next.epoch;
}

/** Applies a system-resume notification. Exported for tests. */
export function applySystemResume(qc: Pick<QueryClient, 'invalidateQueries'>, at = Date.now()) {
  // The watch socket hook subscribes to lastResumeAt and reconnects at once.
  useConnectionStore.getState().markResume(at);
  invalidateDaemonData(qc);
}

let activeSubscriptions = 0;

/**
 * Subscribes this window to daemon-state and system-resume events from the
 * main process. Mount once per window (main App and SessionWindow).
 * Feature-detected: does nothing against an older main process.
 */
export function useConnectionSync(qc: QueryClient, opts: ConnectionSyncOptions = {}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api) return;
    if (activeSubscriptions > 0) return; // already subscribed in this window
    activeSubscriptions++;

    let disposed = false;
    let lastEpoch: number | null = null;
    let lastStatus: DaemonStatus | null = null;
    const handle = (raw: unknown) => {
      if (disposed) return;
      const next = normalizeDaemonState(raw);
      if (!next) return;
      lastEpoch = applyDaemonState(next, lastEpoch, lastStatus, qc, {
        onDaemonRestart: () => optsRef.current.onDaemonRestart?.(),
      });
      lastStatus = next.status;
    };

    const unsubs: Array<() => void> = [];
    if (typeof api.onDaemonState === 'function') {
      const u = api.onDaemonState(handle);
      if (typeof u === 'function') unsubs.push(u);
    }
    if (typeof api.getDaemonState === 'function') {
      Promise.resolve(api.getDaemonState()).then(handle).catch(() => {});
    }
    if (typeof api.onSystemResume === 'function') {
      const u = api.onSystemResume(() => {
        if (!disposed) applySystemResume(qc);
      });
      if (typeof u === 'function') unsubs.push(u);
    }

    return () => {
      disposed = true;
      activeSubscriptions--;
      for (const u of unsubs) u();
    };
  }, [qc]);
}

// ── TopBar indicator ────────────────────────────────────────────────────────

export type DaemonIndicatorLevel = 'ok' | 'reconnecting' | 'down';

export interface DaemonIndicator {
  level: DaemonIndicatorLevel;
  label: string;
  title: string;
}

/**
 * Combines the main process's daemon state with the renderer's own ping.
 * The ping must not retry silently, or a dead daemon keeps looking healthy.
 */
export function deriveDaemonIndicator(input: {
  supported: boolean;
  daemon: DaemonState;
  pingSuccess: boolean;
  pingError: boolean;
  pingErrorMessage?: string;
}): DaemonIndicator {
  const { supported, daemon } = input;
  if (supported && (daemon.status === 'starting' || daemon.status === 'restarting')) {
    return { level: 'reconnecting', label: 'Reconnecting…', title: daemon.status === 'starting' ? 'Daemon starting' : 'Daemon restarting' };
  }
  if (supported && daemon.status === 'failed') {
    return { level: 'down', label: 'Daemon offline', title: daemon.error ? `Daemon failed: ${daemon.error}` : 'Daemon failed' };
  }
  if (input.pingError) {
    return {
      level: 'down',
      label: 'Daemon unreachable',
      title: input.pingErrorMessage ? `Daemon unreachable: ${input.pingErrorMessage}` : 'Daemon unreachable',
    };
  }
  if (input.pingSuccess) {
    return { level: 'ok', label: '', title: 'Daemon connected' };
  }
  return { level: 'reconnecting', label: 'Reconnecting…', title: 'Connecting to daemon' };
}
