import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../state/store';
import {
  type ContextHealth,
  fetchContextHealth,
  isAuthBlocked,
  recordContextHealth,
  useContextHealthStore,
} from '../state/contextHealth';
import { useConnectionStore } from '../state/connectionStore';
import { createBackoff } from '../lib/backoff';

type WatchMessage = {
  type?: string;
  reason?: string;
  group?: string;
  version?: string;
  resource?: string;
  namespace?: string;
  name?: string;
  verb?: string;
  health?: ContextHealth;
};

// Reconnect with jittered exponential backoff (0.5s → 30s), reset once a
// socket has stayed up for 30s.
export const WATCH_BACKOFF = { baseMs: 500, capMs: 30000, stableMs: 30000 } as const;
const FLUSH_DEBOUNCE_MS = 250;
const HEARTBEAT_CHECK_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 55000;

function keyStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function queryKeyMatchesNamespace(queryKey: readonly unknown[], ns: string): boolean {
  if (!ns) return true;
  const qns = keyStr(queryKey[2]);
  return qns === '' || qns === ns;
}

function isOverviewRelevant(msg: WatchMessage): boolean {
  const key = `${msg.group || ''}/${msg.resource || ''}`;
  return key === '/nodes' ||
    key === '/pods' ||
    key === 'apps/deployments' ||
    key === 'apps/statefulsets' ||
    key === 'apps/daemonsets' ||
    key === '/events' ||
    key === 'events.k8s.io/events';
}

function resourceToKindLabel(resource: string, group: string): string {
  const key = `${group}/${resource}`;
  switch (key) {
    case '/pods': return 'Pod';
    case '/nodes': return 'Node';
    case '/services': return 'Service';
    case '/configmaps': return 'ConfigMap';
    case '/persistentvolumeclaims': return 'PersistentVolumeClaim';
    case 'apps/deployments': return 'Deployment';
    case 'apps/statefulsets': return 'StatefulSet';
    case 'apps/daemonsets': return 'DaemonSet';
    case 'apps/replicasets': return 'ReplicaSet';
    case 'batch/jobs': return 'Job';
    case 'batch/cronjobs': return 'CronJob';
    default: return '';
  }
}

export function useLiveResourceInvalidation() {
  const qc = useQueryClient();
  const activeContext = useAppStore((s) => s.activeContext);
  const activeNamespace = useAppStore((s) => s.activeNamespace);
  const setLiveUpdatesConnected = useAppStore((s) => s.setLiveUpdatesConnected);
  const selectedResource = useAppStore((s) => s.selectedResource);
  const selectedResourceNamespace = useAppStore((s) => s.selectedResourceNamespace);
  const selectedKindLabel = useAppStore((s) => s.selectedKindLabel);
  const selectedKind = useAppStore((s) => s.selectedKind);

  const flushTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const selectedResourceRef = useRef(selectedResource);
  const selectedResourceNamespaceRef = useRef(selectedResourceNamespace);
  const selectedKindLabelRef = useRef(selectedKindLabel);
  const selectedKindRef = useRef(selectedKind);
  // While the active context needs sign-in, keep the socket down instead of
  // re-running the exec plugin on every reconnect. Reconnect once it clears.
  const authBlocked = useContextHealthStore((s) => isAuthBlocked(s.byContext[activeContext]));
  const wasAuthBlockedRef = useRef(false);

  useEffect(() => {
    selectedResourceRef.current = selectedResource;
    selectedResourceNamespaceRef.current = selectedResourceNamespace;
    selectedKindLabelRef.current = selectedKindLabel;
    selectedKindRef.current = selectedKind;
  }, [selectedResource, selectedResourceNamespace, selectedKindLabel, selectedKind]);

  useEffect(() => {
    if (!activeContext) {
      setLiveUpdatesConnected(false);
      return;
    }
    if (authBlocked) {
      wasAuthBlockedRef.current = true;
      setLiveUpdatesConnected(false);
      return;
    }
    const recoveredFromAuth = wasAuthBlockedRef.current;
    wasAuthBlockedRef.current = false;

    let cancelled = false;
    let ws: WebSocket | null = null;
    const backoff = createBackoff(WATCH_BACKOFF);
    // Opens in this effect run. Every open after the first may have missed
    // events while the socket was down, so it triggers a full invalidation.
    let openCount = 0;
    // Guards against two overlapping connect() calls both opening a socket.
    let connectSeq = 0;

    const pending = {
      overview: false,
      namespaces: false,
      resourceCounts: false,
      resources: new Set<string>(),
      resourceDetails: new Set<string>(),
      resourceYaml: new Set<string>(),
      podInfo: new Set<string>(),
      logsForPods: new Set<string>(),
      ownedPodsNamespaces: new Set<string>(),
      eventsForObjects: new Set<string>(),
      helmNamespaces: new Set<string>(),
      allEventsForContext: false,
    };

    const clearTimers = () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };

    const invalidateActiveContextQueries = () => {
      qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey as readonly unknown[];
          const root = keyStr(k[0]);
          if (keyStr(k[1]) !== activeContext) return false;
          return root === 'cluster-overview' ||
            root === 'namespaces' ||
            root === 'resourceCounts' ||
            root === 'resources' ||
            root === 'resource' ||
            root === 'yaml' ||
            root === 'podInfo' ||
            root === 'logs' ||
            root === 'ownedPods' ||
            root === 'events' ||
            root === 'helmReleases' ||
            root === 'helmRelease' ||
            root === 'helmReleaseValues' ||
            root === 'helmReleaseHistory';
        },
      });
    };

    const flushPending = () => {
      if (cancelled) return;

      if (pending.overview) {
        qc.invalidateQueries({ queryKey: ['cluster-overview', activeContext] });
      }
      if (pending.namespaces) {
        qc.invalidateQueries({ queryKey: ['namespaces', activeContext] });
      }
      if (pending.resourceCounts) {
        qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey as readonly unknown[];
            return k[0] === 'resourceCounts' && keyStr(k[1]) === activeContext && queryKeyMatchesNamespace(k, activeNamespace);
          },
        });
      }
      if (pending.resources.size > 0) {
        qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey as readonly unknown[];
            if (k[0] !== 'resources' || keyStr(k[1]) !== activeContext) return false;
            if (!queryKeyMatchesNamespace(k, activeNamespace)) return false;
            const sig = `${keyStr(k[3])}/${keyStr(k[4])}/${keyStr(k[5])}`;
            return pending.resources.has(sig);
          },
        });
      }
      if (pending.resourceDetails.size > 0) {
        qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey as readonly unknown[];
            if (k[0] !== 'resource' || keyStr(k[1]) !== activeContext) return false;
            const sig = `${keyStr(k[2])}|${keyStr(k[3])}/${keyStr(k[4])}/${keyStr(k[5])}|${keyStr(k[6])}`;
            return pending.resourceDetails.has(sig);
          },
        });
      }
      if (pending.resourceYaml.size > 0) {
        qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey as readonly unknown[];
            if (k[0] !== 'yaml' || keyStr(k[1]) !== activeContext) return false;
            const sig = `${keyStr(k[2])}|${keyStr(k[3])}/${keyStr(k[4])}/${keyStr(k[5])}|${keyStr(k[6])}`;
            return pending.resourceYaml.has(sig);
          },
        });
      }
      if (pending.podInfo.size > 0) {
        qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey as readonly unknown[];
            if (k[0] !== 'podInfo' || keyStr(k[1]) !== activeContext) return false;
            return pending.podInfo.has(`${keyStr(k[2])}|${keyStr(k[3])}`);
          },
        });
      }
      if (pending.logsForPods.size > 0) {
        qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey as readonly unknown[];
            if (k[0] !== 'logs' || keyStr(k[1]) !== activeContext) return false;
            return pending.logsForPods.has(`${keyStr(k[2])}|${keyStr(k[3])}`);
          },
        });
      }
      if (pending.ownedPodsNamespaces.size > 0) {
        qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey as readonly unknown[];
            if (k[0] !== 'ownedPods' || keyStr(k[1]) !== activeContext) return false;
            return pending.ownedPodsNamespaces.has(keyStr(k[2]));
          },
        });
      }
      if (pending.allEventsForContext) {
        qc.invalidateQueries({ queryKey: ['events', activeContext] });
      } else if (pending.eventsForObjects.size > 0) {
        qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey as readonly unknown[];
            if (k[0] !== 'events' || keyStr(k[1]) !== activeContext) return false;
            const sig = `${keyStr(k[2])}|${keyStr(k[3])}|${keyStr(k[4])}`;
            return pending.eventsForObjects.has(sig);
          },
        });
      }
      if (pending.helmNamespaces.size > 0) {
        qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey as readonly unknown[];
            const root = keyStr(k[0]);
            if (!['helmReleases', 'helmRelease', 'helmReleaseValues', 'helmReleaseHistory'].includes(root)) return false;
            if (keyStr(k[1]) !== activeContext) return false;
            const queryNamespace = keyStr(k[2]);
            return queryNamespace === '' || pending.helmNamespaces.has(queryNamespace);
          },
        });
      }

      pending.overview = false;
      pending.namespaces = false;
      pending.resourceCounts = false;
      pending.allEventsForContext = false;
      pending.resources.clear();
      pending.resourceDetails.clear();
      pending.resourceYaml.clear();
      pending.podInfo.clear();
      pending.logsForPods.clear();
      pending.ownedPodsNamespaces.clear();
      pending.eventsForObjects.clear();
      pending.helmNamespaces.clear();
    };

    const scheduleFlush = () => {
      if (flushTimerRef.current !== null) return;
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        flushPending();
      }, FLUSH_DEBOUNCE_MS);
    };

    const connect = async () => {
      const seq = ++connectSeq;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (window as any).electronAPI;
        // Always read the current port/token: they change when the daemon restarts.
        const cfg = await api?.getDaemonConfig?.();
        if (cancelled || seq !== connectSeq) return;
        if (!cfg) {
          // Daemon not ready (starting/restarting): keep retrying. A daemon
          // "ready" event also reconnects immediately.
          setLiveUpdatesConnected(false);
          scheduleReconnect();
          return;
        }

        const params = new URLSearchParams({ context: activeContext });
        if (activeNamespace) params.set('namespace', activeNamespace);
        const nextWs = new WebSocket(
          `ws://127.0.0.1:${cfg.port}/ws/watch?${params.toString()}`,
          ['truss-watch-v1', `truss-token-${cfg.token}`],
        );
        ws = nextWs;
        let lastMessageAt = Date.now();
        let opened = false;

        if (heartbeatTimerRef.current !== null) {
          window.clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
        }

        nextWs.onopen = () => {
          opened = true;
          if (!cancelled && ws === nextWs) {
            lastMessageAt = Date.now();
            backoff.markConnected();
            if (openCount > 0) {
              // Reconnected: anything that changed while the socket was down was missed.
              invalidateActiveContextQueries();
            }
            openCount++;
            setLiveUpdatesConnected(true);
            heartbeatTimerRef.current = window.setInterval(() => {
              if (cancelled || nextWs.readyState !== WebSocket.OPEN) return;
              if (Date.now() - lastMessageAt <= HEARTBEAT_TIMEOUT_MS) return;
              setLiveUpdatesConnected(false);
              nextWs.close();
            }, HEARTBEAT_CHECK_MS);
          }
        };

        nextWs.onmessage = (evt) => {
          if (cancelled || ws !== nextWs) return;
          lastMessageAt = Date.now();
          let msg: WatchMessage | null = null;
          try {
            msg = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          if (msg && msg.type === 'health' && msg.health) {
            const h = msg.health;
            recordContextHealth({ ...h, context: h.context || activeContext }, qc);
            return;
          }
          if (msg && msg.type === 'resync') {
            // The daemon dropped events for this socket: targeted invalidation
            // can no longer be trusted, so refetch everything for the context.
            invalidateActiveContextQueries();
            return;
          }
          if (!msg || msg.type !== 'resource') return;

          const msgNS = msg.namespace || '';
          if (activeNamespace && msgNS && msgNS !== activeNamespace) return;

          const msgGroup = msg.group || '';
          const msgVersion = msg.version || '';
          const msgResource = msg.resource || '';
          const msgName = msg.name || '';
          const gvrSig = `${msgGroup}/${msgVersion}/${msgResource}`;
          const detailSig = `${msgNS}|${gvrSig}|${msgName}`;

          if (!msgResource) return;

          pending.resources.add(gvrSig);
          if (msgName) {
            pending.resourceDetails.add(detailSig);
            pending.resourceYaml.add(detailSig);
          }

          if (msgResource === 'namespaces' && !msgGroup) {
            pending.namespaces = true;
            pending.resourceCounts = true;
          }
          if (msg.verb === 'add' || msg.verb === 'delete') {
            pending.resourceCounts = true;
          }
          if (isOverviewRelevant(msg)) {
            pending.overview = true;
          }

          if (msgResource === 'pods' && !msgGroup) {
            if (msgName) pending.podInfo.add(`${msgNS}|${msgName}`);
            if (msgName) pending.logsForPods.add(`${msgNS}|${msgName}`);
            pending.ownedPodsNamespaces.add(msgNS);
            if (msgName) pending.eventsForObjects.add(`${msgNS}|Pod|${msgName}`);
          }

          if (
            (msgGroup === 'apps' && ['deployments', 'statefulsets', 'daemonsets', 'replicasets'].includes(msgResource)) ||
            (msgGroup === 'batch' && ['jobs', 'cronjobs'].includes(msgResource))
          ) {
            pending.ownedPodsNamespaces.add(msgNS);
            if (msgName) {
              const kind = resourceToKindLabel(msgResource, msgGroup);
              if (kind) pending.eventsForObjects.add(`${msgNS}|${kind}|${msgName}`);
            }
          }

          if ((msgGroup === 'events.k8s.io' && msgResource === 'events') || (!msgGroup && msgResource === 'events')) {
            pending.allEventsForContext = true;
          }
          if (!msgGroup && (msgResource === 'secrets' || msgResource === 'configmaps')) {
            pending.helmNamespaces.add(msgNS);
          }

          const currentSelectedResource = selectedResourceRef.current;
          const selectedNS = selectedResourceNamespaceRef.current || activeNamespace;
          const currentSelectedKindLabel = selectedKindLabelRef.current;
          const currentSelectedKind = selectedKindRef.current as { group?: string; version?: string; resource?: string } | null;
          if (
            currentSelectedResource &&
            msgName === currentSelectedResource &&
            (!msgNS || msgNS === selectedNS) &&
            currentSelectedKind &&
            keyStr(currentSelectedKind.group) === msgGroup &&
            keyStr(currentSelectedKind.version) === msgVersion &&
            keyStr(currentSelectedKind.resource) === msgResource
          ) {
            pending.resourceDetails.add(`${selectedNS}|${gvrSig}|${currentSelectedResource}`);
            pending.resourceYaml.add(`${selectedNS}|${gvrSig}|${currentSelectedResource}`);
            if (currentSelectedKindLabel) {
              pending.eventsForObjects.add(`${selectedNS}|${currentSelectedKindLabel}|${currentSelectedResource}`);
            }
          }

          scheduleFlush();
        };

        nextWs.onerror = () => {
          if (ws === nextWs) setLiveUpdatesConnected(false);
        };

        nextWs.onclose = () => {
          // A socket replaced by reconnectNow() must not schedule another one.
          if (ws !== nextWs) return;
          ws = null;
          setLiveUpdatesConnected(false);
          if (heartbeatTimerRef.current !== null) {
            window.clearInterval(heartbeatTimerRef.current);
            heartbeatTimerRef.current = null;
          }
          if (cancelled) return;
          if (!opened) {
            // The upgrade was rejected (e.g. HTTP 401 when the context needs
            // sign-in); browsers hide the status, so ask the daemon why.
            void checkHealthThenReconnect();
            return;
          }
          scheduleReconnect();
        };
      } catch {
        if (cancelled || seq !== connectSeq) return;
        setLiveUpdatesConnected(false);
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect();
      }, backoff.next());
    };

    /** Drop the current socket (if any) and connect again right away. */
    const reconnectNow = () => {
      if (cancelled) return;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      backoff.reset();
      const old = ws;
      ws = null;
      if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
        old.close();
      }
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      setLiveUpdatesConnected(false);
      // Count the next open as a reconnect so it refetches what was missed.
      if (openCount === 0) openCount = 1;
      void connect();
    };

    const checkHealthThenReconnect = async () => {
      try {
        const health = await fetchContextHealth(activeContext);
        if (cancelled) return;
        recordContextHealth(health, qc);
        // Recording an AUTH_* state re-runs this effect, which stays offline.
        if (isAuthBlocked(health)) return;
      } catch {
        // Health endpoint unavailable — fall back to plain reconnect.
      }
      scheduleReconnect();
    };

    if (recoveredFromAuth) {
      invalidateActiveContextQueries();
    }
    void connect();

    // Daemon restarts and system resume (sleep/wake) replace the old focus
    // heuristic: reconnect immediately instead of waiting out the backoff.
    const unsubscribeConnection = useConnectionStore.subscribe((state, prev) => {
      const epochChanged = state.daemon.epoch !== prev.daemon.epoch;
      const becameReady = state.daemon.status === 'ready' && prev.daemon.status !== 'ready';
      const resumed = state.lastResumeAt !== prev.lastResumeAt;
      if (state.daemon.status !== 'ready' && !resumed) return;
      if (epochChanged || becameReady || resumed) reconnectNow();
    });

    return () => {
      cancelled = true;
      unsubscribeConnection();
      setLiveUpdatesConnected(false);
      clearTimers();
      const old = ws;
      ws = null;
      if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
        old.close();
      }
    };
  }, [qc, activeContext, activeNamespace, setLiveUpdatesConnected, authBlocked]);
}
