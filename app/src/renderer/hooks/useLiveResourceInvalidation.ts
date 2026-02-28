import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../state/store';

type WatchMessage = {
  type?: string;
  group?: string;
  version?: string;
  resource?: string;
  namespace?: string;
  name?: string;
  verb?: string;
};

const RECONNECT_MS = 2000;
const FLUSH_DEBOUNCE_MS = 250;

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
  const selectedResourceRef = useRef(selectedResource);
  const selectedResourceNamespaceRef = useRef(selectedResourceNamespace);
  const selectedKindLabelRef = useRef(selectedKindLabel);
  const selectedKindRef = useRef(selectedKind);

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

    let cancelled = false;
    let ws: WebSocket | null = null;

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
    };

    const scheduleFlush = () => {
      if (flushTimerRef.current !== null) return;
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        flushPending();
      }, FLUSH_DEBOUNCE_MS);
    };

    const connect = async () => {
      try {
        const api = (window as any).electronAPI;
        const cfg = await api?.getDaemonConfig?.();
        if (!cfg || cancelled) {
          setLiveUpdatesConnected(false);
          return;
        }

        const params = new URLSearchParams({ context: activeContext });
        if (activeNamespace) params.set('namespace', activeNamespace);
        const nextWs = new WebSocket(
          `ws://127.0.0.1:${cfg.port}/ws/watch?${params.toString()}`,
          ['truss-watch-v1', `truss-token-${cfg.token}`],
        );
        ws = nextWs;

        nextWs.onopen = () => {
          if (!cancelled) setLiveUpdatesConnected(true);
        };

        nextWs.onmessage = (evt) => {
          if (cancelled) return;
          let msg: WatchMessage | null = null;
          try {
            msg = JSON.parse(String(evt.data));
          } catch {
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
          setLiveUpdatesConnected(false);
        };

        nextWs.onclose = () => {
          setLiveUpdatesConnected(false);
          if (cancelled) return;
          reconnectTimerRef.current = window.setTimeout(() => {
            void connect();
          }, RECONNECT_MS);
        };
      } catch {
        setLiveUpdatesConnected(false);
        if (!cancelled) {
          reconnectTimerRef.current = window.setTimeout(() => {
            void connect();
          }, RECONNECT_MS);
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      setLiveUpdatesConnected(false);
      clearTimers();
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [qc, activeContext, activeNamespace, setLiveUpdatesConnected]);
}
