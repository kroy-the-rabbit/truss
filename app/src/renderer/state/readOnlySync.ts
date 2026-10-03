import { useEffect, useState } from 'react';
import { fetchSetupAPI } from '../api/client';
import { useAppStore } from './store';

/** Reads the daemon's read-only state. Throws if the daemon is unreachable. */
export async function fetchDaemonReadOnly(): Promise<boolean> {
  const resp = await fetchSetupAPI('/api/readonly');
  if (!resp.ok) throw new Error(`GET /api/readonly failed: ${resp.status}`);
  const data = (await resp.json()) as { readonly?: unknown };
  if (typeof data.readonly !== 'boolean') throw new Error('invalid /api/readonly response');
  return data.readonly;
}

/** Sets the daemon's read-only state and returns the state it reports back. */
export async function pushDaemonReadOnly(readOnly: boolean): Promise<boolean> {
  const resp = await fetchSetupAPI('/api/readonly', {
    method: 'POST',
    body: JSON.stringify({ readonly: readOnly }),
  });
  if (!resp.ok) throw new Error(`POST /api/readonly failed: ${resp.status}`);
  const data = (await resp.json()) as { readonly?: unknown };
  if (typeof data.readonly !== 'boolean') throw new Error('invalid /api/readonly response');
  return data.readonly;
}

// Pushes are serialized so a quick RO -> Write -> RO toggle cannot land out of
// order on the daemon. After each push the latest store value is re-checked.
let syncChain: Promise<void> = Promise.resolve();
// Bumped on every readOnly change so a reconcile that raced with a toggle does
// not undo it (the toggle's own push is already queued behind it).
let toggleGeneration = 0;
useAppStore.subscribe((state, prev) => {
  if (state.readOnly !== prev.readOnly) toggleGeneration++;
});

function forceUiReadOnly() {
  if (!useAppStore.getState().readOnly) {
    useAppStore.getState().setReadOnly(true);
  }
}

/**
 * Pushes the store's current readOnly value to the daemon. Fails closed: if the
 * push fails or the daemon does not confirm write mode, the UI drops back to RO.
 */
export function syncReadOnlyToDaemon(): Promise<void> {
  syncChain = syncChain.then(async () => {
    const wanted = useAppStore.getState().readOnly;
    try {
      // If the daemon did not confirm write mode, the UI must show RO.
      if (await pushDaemonReadOnly(wanted)) forceUiReadOnly();
    } catch {
      forceUiReadOnly();
    }
  });
  return syncChain;
}

/**
 * Reconciles UI and daemon after a (re)connect: if the daemon is RO (e.g. it
 * restarted) the UI follows; if the UI is RO the daemon is told so. Any failure
 * leaves the UI in RO.
 */
export function reconcileReadOnly(): Promise<void> {
  syncChain = syncChain.then(async () => {
    const generation = toggleGeneration;
    try {
      const daemonReadOnly = await fetchDaemonReadOnly();
      if (generation !== toggleGeneration) return;
      if (daemonReadOnly) {
        forceUiReadOnly();
      } else if (useAppStore.getState().readOnly) {
        await pushDaemonReadOnly(true);
      }
    } catch {
      if (generation === toggleGeneration) forceUiReadOnly();
    }
  });
  return syncChain;
}

/**
 * Keeps the main window's RO/Write toggle and the daemon in sync: pushes on
 * every toggle, and reconciles on mount, on reconnect, on focus and periodically.
 */
export function useReadOnlySync(intervalMs = 10000) {
  useEffect(() => {
    void syncReadOnlyToDaemon();
    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (state.readOnly !== prev.readOnly) void syncReadOnlyToDaemon();
      if (state.connected && !prev.connected) void reconcileReadOnly();
    });
    const onFocus = () => { void reconcileReadOnly(); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => { void reconcileReadOnly(); }, intervalMs);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [intervalMs]);
}

/**
 * For popout windows, which have their own renderer store: reads the daemon's
 * RO state (the source of truth). Starts as RO and stays RO if the daemon
 * cannot be reached.
 */
export function useDaemonReadOnly(intervalMs = 3000): boolean {
  const [readOnly, setReadOnly] = useState(true);
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      fetchDaemonReadOnly()
        .then((v) => { if (mounted) setReadOnly(v); })
        .catch(() => { if (mounted) setReadOnly(true); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, intervalMs);
    return () => {
      mounted = false;
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, [intervalMs]);
  return readOnly;
}
