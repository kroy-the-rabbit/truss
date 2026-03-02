import React, { useMemo, useState } from 'react';
import type { Resource } from '../api/gen/truss/v1/resources_pb';
import { GVR } from '../api/gen/truss/v1/resources_pb';
import { useAppStore } from '../state/store';
import { usePodInfo, useOwnedPods, useResourceCounts, useResourceKinds, useResourceYaml } from '../state/queries';

interface Props {
  resource: Resource;
}

function stateClass(state: string): string {
  if (state === 'running') return 'cstate-running';
  if (state === 'waiting') return 'cstate-waiting';
  if (state === 'terminated') return 'cstate-terminated';
  return '';
}

function stateIcon(state: string, ready: boolean): string {
  if (state === 'running' && ready) return '\u25cf'; // ●
  if (state === 'running' && !ready) return '\u25cb'; // ○
  if (state === 'waiting') return '\u25cc'; // ◌
  if (state === 'terminated') return '\u25a0'; // ■
  return '\u25cb'; // ○
}

export function SummaryTab({ resource }: Props) {
  const { selectedKindLabel } = useAppStore();
  const meta = resource.metadata;
  // Dynamic client responses sometimes omit kind; fall back to the store label.
  const effectiveKind = resource.kind || selectedKindLabel;
  const isPod = effectiveKind === 'Pod';
  const isWorkload = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'].includes(effectiveKind);
  const isNamespace = effectiveKind === 'Namespace';
  const isSecret = effectiveKind === 'Secret';
  const isService = effectiveKind === 'Service';
  const isIngress = effectiveKind === 'Ingress';

  return (
    <div className="summary-tab">
      <section className="summary-section">
        <h3>Summary</h3>
        <div className="summary-fields">
          {resource.summary.map((field) => (
            <div key={field.key} className="summary-field">
              <span className="field-key">{field.key}:</span>
              <span className={`field-value ${statusValueClass(field.key, field.value)}`}>{field.value}</span>
            </div>
          ))}
        </div>
      </section>

      {isPod && <ContainerStates podName={meta?.name || ''} namespace={meta?.namespace || ''} />}

      {isWorkload && <OwnedPodsSummary kind={resource.kind} name={meta?.name || ''} namespace={meta?.namespace || ''} />}
      {isNamespace && <NamespaceInventory namespaceName={meta?.name || ''} />}
      {isSecret && <SecretDataSection resource={resource} />}
      {isService && <ServicePortForwardSection resource={resource} />}
      {isIngress && <IngressPortForwardSection resource={resource} />}

      {resource.conditions.length > 0 && (
        <section className="summary-section">
          <h3>Conditions</h3>
          <div className="conditions-list">
            {resource.conditions.map((cond) => (
              <div key={cond.type} className={`condition-badge ${conditionBadgeClass(cond.type, cond.status)}`}>
                <span className="cond-type">{cond.type}</span>
                <span className="cond-status">{cond.status}</span>
                {cond.reason && <span className="cond-reason">{cond.reason}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {meta && (
        <section className="summary-section">
          <h3>Metadata</h3>
          <div className="metadata-fields">
            <div className="meta-field">
              <span className="field-key">Created:</span>
              <span className="field-value">{meta.creationTimestamp}</span>
            </div>
            <div className="meta-field">
              <span className="field-key">UID:</span>
              <span className="field-value mono">{meta.uid}</span>
            </div>
          </div>

          {Object.keys(meta.labels).length > 0 && (
            <div className="labels-section">
              <h4>Labels</h4>
              <div className="label-list">
                {Object.entries(meta.labels).map(([k, v]) => (
                  <span key={k} className="label-badge">
                    {k}={v}
                  </span>
                ))}
              </div>
            </div>
          )}

          {Object.keys(meta.annotations).length > 0 && (
            <div className="annotations-section">
              <h4>Annotations</h4>
              <div className="annotation-list">
                {Object.entries(meta.annotations).map(([k, v]) => (
                  <div key={k} className="annotation-item">
                    <span className="annotation-key">{k}</span>
                    <span className="annotation-value">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ServicePortForwardSection({ resource }: { resource: Resource }) {
  const { activeContext } = useAppStore();
  const meta = resource.metadata;

  // Parse port numbers from summarizer output: "80/TCP, 8080/TCP" → [80, 8080]
  const portsField = resource.summary.find((f) => f.key === 'Ports')?.value || '';
  const ports = portsField
    .split(',')
    .map((s) => parseInt(s.trim().split('/')[0], 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!ports.length) return null;

  const openForward = (port: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI?.openPortForwardWindow?.({
      context: activeContext,
      namespace: meta?.namespace || '',
      targetType: 'service',
      targetName: meta?.name || '',
      targetPort: port,
    });
  };

  return (
    <section className="summary-section">
      <h3>Port Forward</h3>
      <div className="service-ports-forward-list">
        {ports.map((port) => (
          <div key={port} className="service-port-forward-row">
            <span className="service-port-forward-num">{port}</span>
            <button
              className="container-action-btn"
              onClick={() => openForward(port)}
              title={`Port-forward ${meta?.name} port ${port}`}
            >
              Forward
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function IngressPortForwardSection({ resource }: { resource: Resource }) {
  const { activeContext } = useAppStore();
  const meta = resource.metadata;

  // Parse backends from summarizer output: "svcname:80, svcname2:443" → [{name, port}]
  const backendsField = resource.summary.find((f) => f.key === 'Backends')?.value || '';
  const backends = backendsField
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const idx = s.lastIndexOf(':');
      if (idx === -1) return null;
      const name = s.slice(0, idx);
      const port = parseInt(s.slice(idx + 1), 10);
      if (!name || !Number.isFinite(port) || port <= 0) return null;
      return { name, port };
    })
    .filter((b): b is { name: string; port: number } => b !== null);

  if (!backends.length) return null;

  const openForward = (svcName: string, port: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI?.openPortForwardWindow?.({
      context: activeContext,
      namespace: meta?.namespace || '',
      targetType: 'service',
      targetName: svcName,
      targetPort: port,
    });
  };

  return (
    <section className="summary-section">
      <h3>Port Forward (Backends)</h3>
      <div className="service-ports-forward-list">
        {backends.map(({ name, port }) => (
          <div key={`${name}:${port}`} className="service-port-forward-row">
            <span className="service-port-forward-num">{name}:{port}</span>
            <button
              className="container-action-btn"
              onClick={() => openForward(name, port)}
              title={`Port-forward service ${name} port ${port}`}
            >
              Forward
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function NamespaceInventory({ namespaceName }: { namespaceName: string }) {
  const { activeContext, setSelectedKind, setSelectedResource, setActiveNamespace, setActivePane } = useAppStore();
  const resourceKinds = useResourceKinds(activeContext);
  const gvrs = useMemo(() => {
    if (!resourceKinds.data) return [];
    const out: GVR[] = [];
    for (const group of resourceKinds.data.groups) {
      for (const kind of group.kinds) {
        // Namespace view is for namespaced workload/config/service objects.
        if (kind.kind === 'Namespace') continue;
        out.push(new GVR({ group: kind.group, version: kind.version, resource: kind.resource }));
      }
    }
    return out;
  }, [resourceKinds.data]);
  const counts = useResourceCounts(activeContext, namespaceName, gvrs);
  const countMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of counts.data?.counts || []) {
      if (!c.gvr) continue;
      m.set(`${c.gvr.group}/${c.gvr.version}/${c.gvr.resource}`, c.count);
    }
    return m;
  }, [counts.data]);

  const rows = useMemo(() => {
    if (!resourceKinds.data) return [];
    const out: Array<{
      category: string;
      kind: string;
      gvr: GVR;
      count: number;
    }> = [];
    for (const group of resourceKinds.data.groups) {
      for (const kind of group.kinds) {
        if (kind.kind === 'Namespace') continue;
        const key = `${kind.group}/${kind.version}/${kind.resource}`;
        const count = countMap.get(key) ?? 0;
        if (count <= 0) continue;
        out.push({
          category: group.category,
          kind: kind.kind,
          gvr: new GVR({ group: kind.group, version: kind.version, resource: kind.resource }),
          count,
        });
      }
    }
    out.sort((a, b) => a.category.localeCompare(b.category) || a.kind.localeCompare(b.kind));
    return out;
  }, [resourceKinds.data, countMap]);

  const openKind = (row: { kind: string; gvr: GVR }) => {
    setActiveNamespace(namespaceName);
    setSelectedKind(row.gvr, row.kind);
    setSelectedResource('');
    setActivePane('list');
  };

  return (
    <section className="summary-section">
      <h3>Namespace Resources</h3>
      {resourceKinds.isLoading || counts.isLoading ? (
        <div className="loading">Loading namespace inventory...</div>
      ) : rows.length === 0 ? (
        <div className="loading">No namespaced resources found.</div>
      ) : (
        <div className="namespace-inventory-grid">
          {rows.map((row) => (
            <button
              key={`${row.category}:${row.kind}`}
              className="namespace-inventory-item"
              onClick={() => openKind(row)}
              title={`Show ${row.kind} in ${namespaceName}`}
            >
              <span className="namespace-inventory-kind">{row.kind}</span>
              <span className="namespace-inventory-meta">{row.category}</span>
              <span className="namespace-inventory-count">{row.count}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ContainerStates({ podName, namespace }: { podName: string; namespace: string }) {
  const { activeContext } = useAppStore();
  const podInfo = usePodInfo(activeContext, namespace, podName);
  const infos = podInfo.data?.containers || [];
  const podPhase = podInfo.data?.podPhase || '';

  if (podInfo.isLoading) {
    return (
      <section className="summary-section">
        <h3>Containers</h3>
        <div className="loading">Loading container info...</div>
      </section>
    );
  }

  if (infos.length === 0) return null;

  return (
    <section className="summary-section">
      <h3>
        Containers
        {podPhase && (
          <span className={`pod-phase-badge ${podPhaseClass(podPhase)}`}>{podPhase}</span>
        )}
      </h3>
      <div className="container-states">
        {infos.map((c) => (
          <div key={(c.isInit ? 'init:' : '') + c.name} className={`container-card ${stateClass(c.state)}`}>
            <div className="container-card-header">
              <span className={`container-state-icon ${stateClass(c.state)}`}>
                {stateIcon(c.state, c.ready)}
              </span>
              <span className="container-card-name">
                {c.isInit && <span className="container-init-badge">init</span>}
                {c.name}
              </span>
              <span className={`container-state-label ${stateClass(c.state)}`}>
                {c.state || 'unknown'}
              </span>
              <ContainerActions name={c.name} state={c.state} isInit={c.isInit} podName={podName} namespace={namespace} />
            </div>
            <div className="container-card-details">
              <span className="container-detail">
                <span className="container-detail-key">Ready:</span>
                <span className={c.ready ? 'status-ok' : 'status-err'}>{c.ready ? 'Yes' : 'No'}</span>
              </span>
              <span className="container-detail">
                <span className="container-detail-key">Restarts:</span>
                <span className={c.restartCount > 0 ? 'status-warn' : ''}>{c.restartCount}</span>
              </span>
              <span className="container-detail">
                <span className="container-detail-key">Image:</span>
                <span className="container-detail-image" title={c.image}>{c.image}</span>
              </span>
              {c.reason && (
                <span className="container-detail">
                  <span className="container-detail-key">Reason:</span>
                  <span className={c.state === 'waiting' ? 'status-warn' : ''}>{c.reason}</span>
                </span>
              )}
              {c.message && (
                <span className="container-detail">
                  <span className="container-detail-key">Message:</span>
                  <span>{c.message}</span>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ContainerActions({ name, state, isInit, podName, namespace }: { name: string; state: string; isInit: boolean; podName: string; namespace: string }) {
  const { activeContext } = useAppStore();
  const canExec = state === 'running' && !isInit;

  const openSession = (kind: 'logs' | 'exec') => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.openSessionWindow) return;
    api.openSessionWindow({
      kind,
      context: activeContext,
      namespace,
      pod: podName,
      container: name,
    });
  };

  return (
    <span className="container-card-actions">
      <button
        className="container-action-btn"
        onClick={(e) => { e.stopPropagation(); openSession('logs'); }}
        title={`View logs for ${name}`}
      >
        Logs
      </button>
      {canExec && (
        <button
          className="container-action-btn"
          onClick={(e) => { e.stopPropagation(); openSession('exec'); }}
          title={`Exec into ${name}`}
        >
          Exec
        </button>
      )}
      <button
        className="container-action-btn"
        onClick={(e) => {
          e.stopPropagation();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).electronAPI?.openPortForwardWindow?.({
            context: activeContext,
            namespace,
            targetType: 'pod',
            targetName: podName,
          });
        }}
        title={`Port-forward ${podName}`}
      >
        Forward
      </button>
    </span>
  );
}

function OwnedPodsSummary({ kind, name, namespace }: { kind: string; name: string; namespace: string }) {
  const { activeContext, setSelectedKind, setSelectedResource, setActivePane } = useAppStore();
  const ownedPods = useOwnedPods(activeContext, namespace, kind, name);
  const pods = ownedPods.data?.pods || [];

  if (ownedPods.isLoading) {
    return (
      <section className="summary-section">
        <h3>Pods</h3>
        <div className="loading">Loading pods...</div>
      </section>
    );
  }

  const statusCounts: Record<'ok' | 'warn' | 'err', number> = { ok: 0, warn: 0, err: 0 };
  let readyTotal = 0;
  let readyCapacity = 0;
  let restartsTotal = 0;
  let podsWithRestarts = 0;

  for (const pod of pods) {
    const status = getPodField(pod, 'Status');
    const ready = getPodField(pod, 'Ready');
    const restarts = parseInt(getPodField(pod, 'Restarts') || '0', 10) || 0;
    const cls = podStatusClass(status);
    if (cls === 'status-ok') statusCounts.ok += 1;
    else if (cls === 'status-err') statusCounts.err += 1;
    else statusCounts.warn += 1;

    const readyMatch = ready.match(/^(\d+)\/(\d+)$/);
    if (readyMatch) {
      readyTotal += parseInt(readyMatch[1], 10);
      readyCapacity += parseInt(readyMatch[2], 10);
    }

    restartsTotal += restarts;
    if (restarts > 0) podsWithRestarts += 1;
  }

  const openPod = (podName: string, podNamespace: string) => {
    setSelectedKind(new GVR({ group: '', version: 'v1', resource: 'pods' }), 'Pod');
    setSelectedResource(podName, podNamespace);
    setActivePane('inspector');
  };

  return (
    <section className="summary-section">
      <h3>Pods ({pods.length})</h3>
      {pods.length === 0 ? (
        <div className="loading">No pods found</div>
      ) : (
        <>
          <div className="workload-pod-rollup">
            <div className="workload-pod-rollup-item">
              <span className="field-key">Health:</span>
              <span className="workload-pod-chip status-ok">{statusCounts.ok} OK</span>
              <span className="workload-pod-chip status-warn">{statusCounts.warn} Warn</span>
              <span className="workload-pod-chip status-err">{statusCounts.err} Err</span>
            </div>
            <div className="workload-pod-rollup-item">
              <span className="field-key">Ready:</span>
              <span className={readyTotal === readyCapacity ? 'status-ok' : readyTotal === 0 ? 'status-err' : 'status-warn'}>
                {readyCapacity > 0 ? `${readyTotal}/${readyCapacity}` : '-'}
              </span>
            </div>
            <div className="workload-pod-rollup-item">
              <span className="field-key">Restarts:</span>
              <span className={restartsTotal > 0 ? 'status-warn' : ''}>
                {restartsTotal} total ({podsWithRestarts} pods)
              </span>
            </div>
          </div>

          <div className="workload-pods-table">
            <div className="workload-pods-table-head">
              <span>Name</span>
              <span>Status</span>
              <span>Ready</span>
              <span>Restarts</span>
              <span>Age</span>
            </div>
            <div className="workload-pods-table-body">
              {pods.map((pod) => {
                const podName = pod.metadata?.name || '';
                const podNamespace = pod.metadata?.namespace || '';
                const status = getPodField(pod, 'Status');
                const ready = getPodField(pod, 'Ready');
                const restarts = getPodField(pod, 'Restarts') || '0';
                const startedAt = getPodField(pod, 'StartedAt');
                const statusCls = podStatusClass(status);
                return (
                  <button
                    key={pod.metadata?.uid || `${podNamespace}/${podName}`}
                    className="workload-pod-row"
                    onClick={() => openPod(podName, podNamespace)}
                    title={`Open pod ${podName}`}
                  >
                    <span className="mono">{podName}</span>
                    <span className={statusCls}>
                      {statusCls && <span className={`status-dot-inline ${statusCls}`} />}
                      {status || 'Unknown'}
                    </span>
                    <span className={readyStatusClass(ready)}>{ready || '-'}</span>
                    <span className={(parseInt(restarts, 10) || 0) > 0 ? 'status-warn' : ''}>{restarts}</span>
                    <span>{formatAge(startedAt || pod.metadata?.creationTimestamp || '')}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function getPodField(pod: Resource, key: string): string {
  return pod.summary.find((f) => f.key === key)?.value || '';
}

function podStatusClass(value: string): string {
  const v = value.toLowerCase();
  if (v === 'running' || v === 'ready' || v === 'active' || v === 'succeeded' || v === 'completed') return 'status-ok';
  if (v === 'pending' || v === 'containercreating' || v === 'terminating' || v === 'unknown') return 'status-warn';
  if (v === 'failed' || v === 'error' || v === 'crashloopbackoff' || v === 'imagepullbackoff') return 'status-err';
  return 'status-warn';
}

function readyStatusClass(value: string): string {
  const m = value.match(/^(\d+)\/(\d+)$/);
  if (!m) return '';
  const ready = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (total === 0) return '';
  if (ready === total) return 'status-ok';
  if (ready === 0) return 'status-err';
  return 'status-warn';
}

function formatAge(timestamp: string): string {
  if (!timestamp) return '-';
  const created = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function statusValueClass(key: string, value: string): string {
  const v = value.toLowerCase();
  if (key === 'Status') {
    if (v === 'running' || v === 'active' || v === 'ready') return 'status-ok';
    if (v === 'pending' || v === 'unknown') return 'status-warn';
    if (v === 'failed' || v === 'error') return 'status-err';
    if (v === 'succeeded' || v === 'completed') return 'status-ok';
  }
  if (key === 'Ready') {
    const m = value.match(/^(\d+)\/(\d+)$/);
    if (m) {
      if (m[1] === m[2] && m[1] !== '0') return 'status-ok';
      if (m[1] === '0') return 'status-err';
      return 'status-warn';
    }
  }
  return '';
}

function conditionBadgeClass(type: string, status: string): 'ok' | 'warn' | 'err' {
  const normalizedType = type.toLowerCase();
  const normalizedStatus = status.toLowerCase();
  const isTrue = normalizedStatus === 'true';
  const isFalse = normalizedStatus === 'false';

  if (!isTrue && !isFalse) return 'warn';

  // Node "pressure" and availability conditions are healthy when False.
  const inverseTrueIsBad = new Set([
    'memorypressure',
    'diskpressure',
    'pidpressure',
    'networkunavailable',
    'outofdisk',
  ]);

  // Standard readiness conditions are healthy when True.
  const trueIsGood = new Set([
    'ready',
  ]);

  if (inverseTrueIsBad.has(normalizedType)) {
    return isTrue ? 'err' : 'ok';
  }

  if (trueIsGood.has(normalizedType)) {
    return isTrue ? 'ok' : 'err';
  }

  // Default conservatively: True is good, False is warning (not error).
  return isTrue ? 'ok' : 'warn';
}

function podPhaseClass(phase: string): string {
  const p = phase.toLowerCase();
  if (p === 'running') return 'phase-running';
  if (p === 'succeeded') return 'phase-succeeded';
  if (p === 'pending') return 'phase-pending';
  if (p === 'failed') return 'phase-failed';
  return 'phase-unknown';
}

function extractDataMap(yamlStr: string): Record<string, string> {
  const lines = yamlStr.split('\n');
  const result: Record<string, string> = {};
  let inData = false;
  for (const line of lines) {
    if (/^data:\s*$/.test(line)) {
      inData = true;
      continue;
    }
    if (inData) {
      const m = line.match(/^  ([^:\s][^:]*):\s*(.*)$/);
      if (m) {
        result[m[1].trim()] = m[2].trim();
      } else if (/^\S/.test(line)) {
        inData = false;
      }
    }
  }
  return result;
}

function b64Decode(s: string): string {
  try {
    return atob(s);
  } catch {
    return '[invalid base64]';
  }
}

function SecretDataSection({ resource }: { resource: Resource }) {
  const { activeContext, selectedKind } = useAppStore();
  const meta = resource.metadata;
  const name = meta?.name || '';
  const namespace = meta?.namespace || '';
  const yaml = useResourceYaml(activeContext, namespace, selectedKind, name);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());

  const dataMap = useMemo(() => {
    if (!yaml.data?.yaml) return {} as Record<string, string>;
    return extractDataMap(yaml.data.yaml);
  }, [yaml.data?.yaml]);

  const toggleReveal = (key: string) => {
    setRevealedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const keys = Object.keys(dataMap);

  if (yaml.isLoading) {
    return (
      <section className="summary-section">
        <h3>Data</h3>
        <div className="loading">Loading...</div>
      </section>
    );
  }

  if (keys.length === 0) return null;

  return (
    <section className="summary-section">
      <h3>Data</h3>
      <div className="secret-data-list">
        {keys.map(key => {
          const revealed = revealedKeys.has(key);
          return (
            <div key={key} className="secret-data-item">
              <span className="secret-data-key">{key}</span>
              <span className="secret-data-value mono">
                {revealed ? b64Decode(dataMap[key]) : '••••••••'}
              </span>
              <button className={`secret-data-toggle ${revealed ? 'secret-data-toggle-yes' : ''}`} onClick={() => toggleReveal(key)}>
                Decoded: {revealed ? 'Yes' : 'No'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
