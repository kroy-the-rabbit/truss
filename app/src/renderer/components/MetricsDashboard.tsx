import React, { useMemo, useRef, useState, useCallback } from 'react';
import { useAppStore } from '../state/store';
import {
  useClusterOverview,
  useResources,
  useDebugNode,
  useDeleteDebugPod,
  usePrometheusDiscover,
  usePrometheusRange,
  usePrometheusInstant,
  useSetPrometheusURL,
  type PrometheusEndpoint,
} from '../state/queries';
import { useToast } from '../hooks/useToast';
import { MetricsLineChart } from './MetricsLineChart';
import { GVR } from '../api/gen/truss/v1/resources_pb';
import type { Resource } from '../api/gen/truss/v1/resources_pb';
import type { GetClusterOverviewResponse } from '../api/gen/truss/v1/overview_pb';

// PromQL queries
const CPU_RANGE_QUERY = `sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))`;
const MEM_RANGE_QUERY = `sum(container_memory_working_set_bytes{container!="",container!="POD"})`;
const NS_CPU_QUERY = `sort_desc(sum by (namespace)(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))`;
const NS_MEM_QUERY = `sort_desc(sum by (namespace)(container_memory_working_set_bytes{container!="",container!="POD"}))`;
const NODE_CPU_QUERY = `sort_desc(sum by (node)(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))`;
const NODE_MEM_QUERY = `sort_desc(sum by (node)(container_memory_working_set_bytes{container!="",container!="POD"}))`;

type TimeRange = '15m' | '1h' | '6h' | '24h';
type Tab = 'overview' | 'nodes' | 'workloads' | 'prometheus';

function timeRangeToParams(range: TimeRange) {
  const now = Math.floor(Date.now() / 1000);
  const durations: Record<TimeRange, number> = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };
  const steps: Record<TimeRange, number> = { '15m': 15, '1h': 60, '6h': 360, '24h': 1440 };
  return { start: now - durations[range], end: now, step: steps[range] };
}

function fmtCpu(milli: number): string {
  if (milli <= 0) return '0m';
  return milli >= 1000 ? `${(milli / 1000).toFixed(2)}c` : `${milli}m`;
}

function fmtMem(bytes: number): string {
  if (bytes <= 0) return '0B';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)}KB`;
  return `${bytes}B`;
}

function fmtPercent(used: number, total: number): string {
  return total > 0 ? `${Math.round((used / total) * 100)}%` : '-';
}

function pct(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
}

function barClass(p: number): string {
  if (p > 80) return 'high';
  if (p > 60) return 'medium';
  return 'low';
}

function timeAgo(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff) || diff < 0) return '';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function parseRangeResult(data: unknown): { t: number; v: number }[] {
  try {
    const d = data as { data?: { result?: { values?: [number, string][] }[] } };
    const values = d?.data?.result?.[0]?.values ?? [];
    return values.map(([t, v]) => ({ t, v: parseFloat(v) }));
  } catch {
    return [];
  }
}

function parseInstantResult(data: unknown): { label: string; value: number }[] {
  try {
    const d = data as {
      data?: { result?: { metric?: Record<string, string>; value?: [number, string] }[] };
    };
    return (d?.data?.result ?? []).map((r) => {
      const label = r.metric?.namespace ?? r.metric?.node ?? Object.values(r.metric ?? {})[0] ?? '?';
      return { label, value: parseFloat(r.value?.[1] ?? '0') };
    });
  } catch {
    return [];
  }
}

function aggregateByNamespace(data: GetClusterOverviewResponse | undefined) {
  if (!data) return [];
  const map = new Map<string, { cpu: number; mem: number }>();
  for (const p of [...(data.topCpuPods ?? []), ...(data.topMemPods ?? [])]) {
    const e = map.get(p.namespace) ?? { cpu: 0, mem: 0 };
    map.set(p.namespace, { cpu: e.cpu + Number(p.cpuM), mem: e.mem + Number(p.memBytes) });
  }
  return [...map.entries()]
    .map(([ns, v]) => ({ label: ns, cpuM: v.cpu, memBytes: v.mem }))
    .sort((a, b) => b.cpuM - a.cpuM);
}

// ── Header bar ──────────────────────────────────────────────────────────────

function badgeClass(ep: PrometheusEndpoint | null | undefined) {
  if (!ep) return 'metrics-prometheus-badge none';
  return ep.source === 'manual' ? 'metrics-prometheus-badge manual' : 'metrics-prometheus-badge found';
}
function badgeLabel(ep: PrometheusEndpoint | null | undefined) {
  if (!ep) return 'Prometheus: not detected';
  if (ep.source === 'manual') return `Prometheus: manual (${ep.url})`;
  return `Prometheus: ${ep.namespace}/${ep.service}:${ep.port}`;
}

// ── Shared sub-components ────────────────────────────────────────────────────

function SummaryCard({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="metrics-card">
      <div className="metrics-card-value">{value}</div>
      <div className="metrics-card-label">{label}</div>
      {sub && <div className="metrics-card-sub">{sub}</div>}
    </div>
  );
}

function MiniBar({ used, total, fmt }: { used: number; total: number; fmt: (v: number) => string }) {
  const p = pct(used, total);
  return (
    <div className="metrics-bar-wrap">
      <div className="metrics-bar-track">
        <div className={`metrics-bar-fill ${barClass(p)}`} style={{ width: `${p}%` }} />
      </div>
      <span>{fmt(used)}/{fmt(total)} ({p}%)</span>
    </div>
  );
}

// ── Warning navigation ───────────────────────────────────────────────────────

const KIND_GVR: Record<string, { group: string; version: string; resource: string; label: string }> = {
  Pod:         { group: '',      version: 'v1',  resource: 'pods',          label: 'Pod' },
  Node:        { group: '',      version: 'v1',  resource: 'nodes',         label: 'Node' },
  Deployment:  { group: 'apps',  version: 'v1',  resource: 'deployments',   label: 'Deployment' },
  StatefulSet: { group: 'apps',  version: 'v1',  resource: 'statefulsets',  label: 'StatefulSet' },
  DaemonSet:   { group: 'apps',  version: 'v1',  resource: 'daemonsets',    label: 'DaemonSet' },
  ReplicaSet:  { group: 'apps',  version: 'v1',  resource: 'replicasets',   label: 'ReplicaSet' },
  Job:         { group: 'batch', version: 'v1',  resource: 'jobs',          label: 'Job' },
  CronJob:     { group: 'batch', version: 'v1',  resource: 'cronjobs',      label: 'CronJob' },
  Service:     { group: '',      version: 'v1',  resource: 'services',      label: 'Service' },
  PersistentVolumeClaim: { group: '', version: 'v1', resource: 'persistentvolumeclaims', label: 'PersistentVolumeClaim' },
};

interface WarningEvent {
  involvedKind: string;
  involvedName: string;
  namespace: string;
  reason: string;
  message: string;
  lastTime: string;
  count: number;
}

function WarningsTable({
  warnings,
  navToResource,
}: {
  warnings: WarningEvent[];
  navToResource: (kind: string, name: string, ns: string) => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);

  const toggle = useCallback((i: number) => {
    setExpanded((prev) => (prev === i ? null : i));
  }, []);

  if (warnings.length === 0) {
    return <div className="metrics-no-data">No recent warnings</div>;
  }

  return (
    <table className="metrics-table">
      <thead>
        <tr>
          <th style={{ width: 24 }} />
          <th>Kind / Name</th>
          <th>Reason</th>
          <th>Message</th>
          <th>Age</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
        {warnings.slice(0, 10).map((ev, i) => {
          const gvr = KIND_GVR[ev.involvedKind];
          const canNav = Boolean(gvr && ev.involvedName);
          const isOpen = expanded === i;
          return (
            <React.Fragment key={i}>
              <tr
                className={`metrics-warning-row${isOpen ? ' metrics-warning-row-open' : ''}`}
                onClick={() => toggle(i)}
                title="Click to expand"
              >
                <td className="metrics-expand-cell">{isOpen ? '▼' : '▶'}</td>
                <td>
                  <span className="metrics-kind-badge">{ev.involvedKind || '—'}</span>
                  {' '}
                  <span
                    className={canNav ? 'metrics-warn-link' : ''}
                    title={canNav ? `Navigate to ${ev.involvedKind}/${ev.involvedName}` : ev.involvedName}
                    onClick={canNav ? (e) => { e.stopPropagation(); navToResource(ev.involvedKind, ev.involvedName, ev.namespace); } : undefined}
                  >
                    {ev.involvedName || '—'}
                  </span>
                </td>
                <td><span className="metrics-warn-reason">{ev.reason}</span></td>
                <td className="metrics-cell-truncate metrics-cell-wide" title={ev.message}>{ev.message}</td>
                <td className="metrics-cell-dim" style={{ whiteSpace: 'nowrap' }}>{timeAgo(ev.lastTime)}</td>
                <td className="metrics-cell-dim" style={{ textAlign: 'right' }}>{ev.count > 1 ? ev.count : ''}</td>
              </tr>
              {isOpen && (
                <tr className="metrics-warning-detail-row">
                  <td />
                  <td colSpan={5}>
                    <div className="metrics-warning-detail">
                      <div className="metrics-warning-detail-label">Full message</div>
                      <div className="metrics-warning-detail-msg">{ev.message || '(no message)'}</div>
                      {ev.namespace && (
                        <div className="metrics-warning-detail-meta">Namespace: {ev.namespace}</div>
                      )}
                      {canNav && (
                        <button
                          className="btn-secondary metrics-warning-nav-btn"
                          onClick={(e) => { e.stopPropagation(); navToResource(ev.involvedKind, ev.involvedName, ev.namespace); }}
                        >
                          Go to {ev.involvedKind} → {ev.involvedName}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Tab: Overview ────────────────────────────────────────────────────────────

function OverviewTab({
  overview,
  navToPod,
  navToResource,
}: {
  overview: GetClusterOverviewResponse | undefined;
  navToPod: (name: string, ns: string) => void;
  navToResource: (kind: string, name: string, ns: string) => void;
}) {
  const nodes = overview?.nodes;
  const pods = overview?.pods;
  const deps = overview?.deployments;
  const sts = overview?.statefulSets;
  const ds = overview?.daemonSets;

  const clusterCpu = useMemo(() => {
    const ms = nodes?.metrics ?? [];
    if (!ms.length) return null;
    const used = ms.reduce((s, m) => s + Number(m.cpuUsedM), 0);
    const alloc = ms.reduce((s, m) => s + Number(m.cpuAllocM), 0);
    return { used, alloc };
  }, [nodes]);

  const clusterMem = useMemo(() => {
    const ms = nodes?.metrics ?? [];
    if (!ms.length) return null;
    const used = ms.reduce((s, m) => s + Number(m.memUsedBytes), 0);
    const alloc = ms.reduce((s, m) => s + Number(m.memAllocBytes), 0);
    return { used, alloc };
  }, [nodes]);

  return (
    <div className="metrics-tab-content">
      {/* Summary cards — 6 across */}
      <div className="metrics-cards metrics-cards-6">
        <SummaryCard
          value={nodes ? `${nodes.ready}/${nodes.total}` : '-'}
          label="Nodes Ready"
        />
        <SummaryCard
          value={pods ? String(pods.running) : '-'}
          label="Pods Running"
          sub={pods ? `${pods.pending}p · ${pods.failed}f` : undefined}
        />
        <SummaryCard
          value={deps ? `${deps.ready}/${deps.total}` : '-'}
          label="Deployments"
          sub={deps && deps.updating > 0 ? `${deps.updating} updating` : undefined}
        />
        <SummaryCard
          value={sts ? `${sts.ready}/${sts.total}` : '-'}
          label="StatefulSets"
        />
        <SummaryCard
          value={clusterCpu ? fmtPercent(clusterCpu.used, clusterCpu.alloc) : '-'}
          label="Cluster CPU"
          sub={clusterCpu ? `${fmtCpu(clusterCpu.used)} / ${fmtCpu(clusterCpu.alloc)}` : undefined}
        />
        <SummaryCard
          value={clusterMem ? fmtPercent(clusterMem.used, clusterMem.alloc) : '-'}
          label="Cluster Mem"
          sub={clusterMem ? `${fmtMem(clusterMem.used)} / ${fmtMem(clusterMem.alloc)}` : undefined}
        />
      </div>

      {/* Middle row: warnings + pod phases */}
      <div className="metrics-bottom-grid metrics-bottom-grid-3col">
        <div className="metrics-table-box metrics-col-span-2">
          <div className="metrics-table-title">Recent Warnings</div>
          <WarningsTable
            warnings={overview?.recentWarnings ?? []}
            navToResource={navToResource}
          />
        </div>

        <div className="metrics-table-box">
          <div className="metrics-table-title">Pod Phases</div>
          <div className="metrics-phases">
            {[
              { label: 'Running',   value: pods?.running ?? 0,   cls: 'status-ok' },
              { label: 'Pending',   value: pods?.pending ?? 0,   cls: 'status-warn' },
              { label: 'Failed',    value: pods?.failed ?? 0,    cls: 'status-error' },
              { label: 'Succeeded', value: pods?.succeeded ?? 0, cls: 'status-dim' },
              { label: 'Unknown',   value: pods?.unknown ?? 0,   cls: 'status-dim' },
            ].map((row) => (
              <div key={row.label} className="metrics-phase-row">
                <span className={`metrics-phase-dot ${row.cls}`} />
                <span className="metrics-phase-label">{row.label}</span>
                <span className="metrics-phase-value">{row.value}</span>
              </div>
            ))}
          </div>

          <div className="metrics-table-title" style={{ marginTop: 12 }}>Workload Health</div>
          <div className="metrics-phases">
            {[
              { label: 'Deployments',  ready: deps?.ready ?? 0,  total: deps?.total ?? 0,  updating: deps?.updating ?? 0 },
              { label: 'StatefulSets', ready: sts?.ready ?? 0,   total: sts?.total ?? 0,   updating: sts?.updating ?? 0 },
              { label: 'DaemonSets',   ready: ds?.ready ?? 0,    total: ds?.total ?? 0,    updating: ds?.updating ?? 0 },
            ].map((row) => (
              <div key={row.label} className="metrics-phase-row">
                <span className={`metrics-phase-dot ${row.ready === row.total && row.total > 0 ? 'status-ok' : row.updating > 0 ? 'status-warn' : row.total > 0 ? 'status-error' : 'status-dim'}`} />
                <span className="metrics-phase-label">{row.label}</span>
                <span className="metrics-phase-value">{row.ready}/{row.total}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Top consumers */}
      <div className="metrics-bottom-grid">
        <div className="metrics-table-box">
          <div className="metrics-table-title">Top CPU Pods</div>
          <table className="metrics-table">
            <thead><tr><th>Pod</th><th>Namespace</th><th>CPU</th></tr></thead>
            <tbody>
              {(overview?.topCpuPods ?? []).map((p) => (
                <tr key={`${p.namespace}/${p.name}`} onClick={() => navToPod(p.name, p.namespace)}>
                  <td>{p.name}</td><td>{p.namespace}</td><td>{fmtCpu(Number(p.cpuM))}</td>
                </tr>
              ))}
              {(overview?.topCpuPods ?? []).length === 0 && (
                <tr><td colSpan={3} className="metrics-cell-dim" style={{ textAlign: 'center' }}>No data</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="metrics-table-box">
          <div className="metrics-table-title">Top Memory Pods</div>
          <table className="metrics-table">
            <thead><tr><th>Pod</th><th>Namespace</th><th>Memory</th></tr></thead>
            <tbody>
              {(overview?.topMemPods ?? []).map((p) => (
                <tr key={`${p.namespace}/${p.name}`} onClick={() => navToPod(p.name, p.namespace)}>
                  <td>{p.name}</td><td>{p.namespace}</td><td>{fmtMem(Number(p.memBytes))}</td>
                </tr>
              ))}
              {(overview?.topMemPods ?? []).length === 0 && (
                <tr><td colSpan={3} className="metrics-cell-dim" style={{ textAlign: 'center' }}>No data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tab: Nodes ───────────────────────────────────────────────────────────────

function podField(pod: Resource, key: string): string {
  return pod.summary.find((f) => f.key === key)?.value ?? '';
}

function podStatusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'running') return 'status-ok';
  if (s === 'succeeded' || s === 'completed') return 'status-ok';
  if (s === 'pending' || s === 'containercreating') return 'status-warn';
  if (s === 'failed' || s === 'crashloopbackoff' || s === 'imagepullbackoff' || s === 'error') return 'status-error';
  return '';
}

function NodesTab({
  overview,
  activeContext,
  navToPod,
}: {
  overview: GetClusterOverviewResponse | undefined;
  activeContext: string;
  navToPod: (name: string, ns: string) => void;
}) {
  const metrics = overview?.nodes?.metrics ?? [];
  const hasMetrics = overview?.metricsAvailable ?? false;
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const [debuggingNodes, setDebuggingNodes] = useState<Record<string, boolean>>({});

  const addToast = useToast((s) => s.addToast);
  const debugNode = useDebugNode();
  const deleteDebugPod = useDeleteDebugPod();

  const podsGvr = useMemo(() => new GVR({ group: '', version: 'v1', resource: 'pods' }), []);
  const allPods = useResources(activeContext, '', podsGvr);

  const podsByNode = useMemo(() => {
    const m = new Map<string, Resource[]>();
    for (const pod of (allPods.data?.resources ?? [])) {
      const nodeName = podField(pod, 'Node');
      if (!nodeName) continue;
      const existing = m.get(nodeName) ?? [];
      existing.push(pod);
      m.set(nodeName, existing);
    }
    return m;
  }, [allPods.data]);

  const toggleNode = (name: string) => {
    setExpandedNode((prev) => (prev === name ? null : name));
  };

  const handleDebugNode = async (nodeName: string) => {
    setDebuggingNodes((prev) => ({ ...prev, [nodeName]: true }));
    try {
      const result = await debugNode.mutateAsync({ context: activeContext, node: nodeName });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).electronAPI;
      if (api?.openSessionWindow) {
        api.openSessionWindow({
          kind: 'exec',
          context: activeContext,
          namespace: result.namespace,
          pod: result.pod,
          container: result.container,
        });
      } else {
        // Fallback: navigate to the pod
        navToPod(result.pod, result.namespace);
      }
      addToast('success', `Debug pod ${result.pod} created in namespace ${result.namespace}. Delete it when done.`);
    } catch (err) {
      addToast('error', `Node debug failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDebuggingNodes((prev) => ({ ...prev, [nodeName]: false }));
    }
  };

  return (
    <div className="metrics-tab-content">
      {/* Node status summary */}
      <div className="metrics-cards metrics-cards-4">
        <SummaryCard value={String(overview?.nodes?.total ?? '-')} label="Total Nodes" />
        <SummaryCard value={String(overview?.nodes?.ready ?? '-')} label="Ready" />
        <SummaryCard value={String(overview?.nodes?.notReady ?? 0)} label="Not Ready" />
        <SummaryCard
          value={metrics.length > 0
            ? fmtPercent(
                metrics.reduce((s, m) => s + Number(m.cpuUsedM), 0),
                metrics.reduce((s, m) => s + Number(m.cpuAllocM), 0),
              )
            : '-'}
          label="Cluster CPU Util"
        />
      </div>

      <div className="metrics-table-box">
        <div className="metrics-table-title">
          Node Breakdown — click a row to see pods
          {!hasMetrics && <span className="metrics-badge-dim"> (metrics-server not available)</span>}
        </div>
        <table className="metrics-table">
          <thead>
            <tr>
              <th style={{ width: 24 }} />
              <th>Node</th>
              <th>Pods</th>
              <th>CPU Used</th>
              <th>CPU Alloc</th>
              <th>CPU %</th>
              <th>Mem Used</th>
              <th>Mem Alloc</th>
              <th>Mem %</th>
              <th style={{ width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              const cpuUsed = Number(m.cpuUsedM);
              const cpuAlloc = Number(m.cpuAllocM);
              const memUsed = Number(m.memUsedBytes);
              const memAlloc = Number(m.memAllocBytes);
              const cpuP = pct(cpuUsed, cpuAlloc);
              const memP = pct(memUsed, memAlloc);
              const isOpen = expandedNode === m.name;
              const nodePods = podsByNode.get(m.name) ?? [];
              const isDebugging = !!debuggingNodes[m.name];
              return (
                <React.Fragment key={m.name}>
                  <tr
                    className={`metrics-node-row${isOpen ? ' metrics-node-row-open' : ''}`}
                    onClick={() => toggleNode(m.name)}
                    title="Click to show pods on this node"
                  >
                    <td className="metrics-expand-cell">{isOpen ? '▼' : '▶'}</td>
                    <td><strong>{m.name}</strong></td>
                    <td className="metrics-cell-dim">{allPods.isLoading ? '…' : nodePods.length}</td>
                    <td>{fmtCpu(cpuUsed)}</td>
                    <td>{fmtCpu(cpuAlloc)}</td>
                    <td>
                      <div className="metrics-bar-wrap">
                        <div className="metrics-bar-track">
                          <div className={`metrics-bar-fill ${barClass(cpuP)}`} style={{ width: `${cpuP}%` }} />
                        </div>
                        <span>{cpuP}%</span>
                      </div>
                    </td>
                    <td>{fmtMem(memUsed)}</td>
                    <td>{fmtMem(memAlloc)}</td>
                    <td>
                      <div className="metrics-bar-wrap">
                        <div className="metrics-bar-track">
                          <div className={`metrics-bar-fill ${barClass(memP)}`} style={{ width: `${memP}%` }} />
                        </div>
                        <span>{memP}%</span>
                      </div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn-secondary metrics-node-debug-btn"
                        disabled={isDebugging}
                        title="Create a privileged debug pod on this node and open an exec session"
                        onClick={() => handleDebugNode(m.name)}
                      >
                        {isDebugging ? 'Starting…' : '⬡ Exec'}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="metrics-node-pods-row">
                      <td />
                      <td colSpan={9}>
                        <div className="metrics-node-pods">
                          <div className="metrics-node-pods-title">{nodePods.length} pod{nodePods.length !== 1 ? 's' : ''} on {m.name}</div>
                          <table className="metrics-node-pods-table">
                            <thead>
                              <tr>
                                <th>Name</th>
                                <th>Namespace</th>
                                <th>Status</th>
                                <th>Ready</th>
                                <th>Restarts</th>
                                <th style={{ width: 32 }} />
                              </tr>
                            </thead>
                            <tbody>
                              {nodePods.map((pod) => {
                                const status = podField(pod, 'Status');
                                const ready = podField(pod, 'Ready');
                                const restarts = podField(pod, 'Restarts');
                                const podName = pod.metadata?.name ?? '';
                                const podNs = pod.metadata?.namespace ?? '';
                                const isDebugPod = podName.startsWith('truss-node-debug-');
                                return (
                                  <tr
                                    key={`${podNs}/${podName}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navToPod(podName, podNs);
                                    }}
                                  >
                                    <td>
                                      {isDebugPod && <span className="metrics-debug-pod-tag">debug </span>}
                                      {podName}
                                    </td>
                                    <td className="metrics-cell-dim">{podNs}</td>
                                    <td>
                                      <span className={`status-dot ${podStatusClass(status)}`} />
                                      {status}
                                    </td>
                                    <td className="metrics-cell-dim">{ready}</td>
                                    <td className="metrics-cell-dim">{restarts}</td>
                                    <td onClick={(e) => e.stopPropagation()}>
                                      {isDebugPod && (
                                        <button
                                          className="metrics-node-debug-del-btn"
                                          title="Delete this debug pod"
                                          onClick={async () => {
                                            try {
                                              await deleteDebugPod.mutateAsync({ context: activeContext, pod: podName, namespace: podNs });
                                              addToast('success', `Deleted ${podName}`);
                                            } catch (err) {
                                              addToast('error', `Delete failed: ${err instanceof Error ? err.message : String(err)}`);
                                            }
                                          }}
                                        >
                                          ✕
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                              {nodePods.length === 0 && (
                                <tr>
                                  <td colSpan={6} className="metrics-cell-dim" style={{ textAlign: 'center', padding: 8 }}>
                                    {allPods.isLoading ? 'Loading pods…' : 'No pods scheduled on this node'}
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {metrics.length === 0 && (
              <tr><td colSpan={10} className="metrics-cell-dim" style={{ textAlign: 'center', padding: 16 }}>
                {hasMetrics ? 'No node metrics' : 'Install metrics-server to see node utilization'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tab: Workloads ──────────────────────────────────────────────────────────

function WorkloadsTab({ overview }: { overview: GetClusterOverviewResponse | undefined }) {
  const deps = overview?.deployments;
  const sts = overview?.statefulSets;
  const ds = overview?.daemonSets;
  const pods = overview?.pods;

  const workloads = [
    { label: 'Deployments',  data: deps, icon: '▣' },
    { label: 'StatefulSets', data: sts,  icon: '◈' },
    { label: 'DaemonSets',   data: ds,   icon: '◉' },
  ];

  return (
    <div className="metrics-tab-content">
      <div className="metrics-cards metrics-cards-4">
        <SummaryCard value={String(deps?.total ?? '-')} label="Deployments" sub={deps ? `${deps.ready} ready` : undefined} />
        <SummaryCard value={String(sts?.total ?? '-')} label="StatefulSets" sub={sts ? `${sts.ready} ready` : undefined} />
        <SummaryCard value={String(ds?.total ?? '-')} label="DaemonSets" sub={ds ? `${ds.ready} ready` : undefined} />
        <SummaryCard value={String((pods?.running ?? 0) + (pods?.pending ?? 0) + (pods?.failed ?? 0))} label="Total Pods" sub={pods ? `${pods.running} running` : undefined} />
      </div>

      <div className="metrics-bottom-grid metrics-bottom-grid-3col">
        {workloads.map(({ label, data }) => (
          <div key={label} className="metrics-table-box">
            <div className="metrics-table-title">{label}</div>
            {!data || data.total === 0 ? (
              <div className="metrics-no-data">None found</div>
            ) : (
              <div className="metrics-workload-breakdown">
                <div className="metrics-workload-bar-row">
                  <span className="metrics-workload-bar-label">Ready</span>
                  <div className="metrics-workload-bar-track">
                    <div
                      className="metrics-workload-bar-fill status-ok"
                      style={{ width: `${pct(data.ready, data.total)}%` }}
                    />
                  </div>
                  <span className="metrics-workload-bar-count">{data.ready}/{data.total}</span>
                </div>
                {data.updating > 0 && (
                  <div className="metrics-workload-bar-row">
                    <span className="metrics-workload-bar-label">Updating</span>
                    <div className="metrics-workload-bar-track">
                      <div
                        className="metrics-workload-bar-fill status-warn"
                        style={{ width: `${pct(data.updating, data.total)}%` }}
                      />
                    </div>
                    <span className="metrics-workload-bar-count">{data.updating}</span>
                  </div>
                )}
                {data.notReady > 0 && (
                  <div className="metrics-workload-bar-row">
                    <span className="metrics-workload-bar-label">Not Ready</span>
                    <div className="metrics-workload-bar-track">
                      <div
                        className="metrics-workload-bar-fill status-error"
                        style={{ width: `${pct(data.notReady, data.total)}%` }}
                      />
                    </div>
                    <span className="metrics-workload-bar-count">{data.notReady}</span>
                  </div>
                )}
                <div className="metrics-workload-health-pct">
                  {pct(data.ready, data.total)}% healthy
                </div>
              </div>
            )}
          </div>
        ))}

        <div className="metrics-table-box">
          <div className="metrics-table-title">Pod Phases</div>
          <div className="metrics-phases">
            {[
              { label: 'Running',   value: pods?.running ?? 0,   cls: 'status-ok' },
              { label: 'Pending',   value: pods?.pending ?? 0,   cls: 'status-warn' },
              { label: 'Failed',    value: pods?.failed ?? 0,    cls: 'status-error' },
              { label: 'Succeeded', value: pods?.succeeded ?? 0, cls: 'status-dim' },
              { label: 'Unknown',   value: pods?.unknown ?? 0,   cls: 'status-dim' },
            ].map((r) => (
              <div key={r.label} className="metrics-phase-row">
                <span className={`metrics-phase-dot ${r.cls}`} />
                <span className="metrics-phase-label">{r.label}</span>
                <span className="metrics-phase-value">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tab: Prometheus ──────────────────────────────────────────────────────────

function PrometheusTab({
  ep,
  activeContext,
  timeRange,
  setTimeRange,
}: {
  ep: PrometheusEndpoint | null;
  activeContext: string;
  timeRange: TimeRange;
  setTimeRange: (r: TimeRange) => void;
}) {
  const [queryDraft, setQueryDraft] = useState('');
  const [customQuery, setCustomQuery] = useState('');

  const { start, end, step } = useMemo(() => timeRangeToParams(timeRange), [timeRange]);

  const cpuRange = usePrometheusRange(
    ep ? { context: activeContext, ep, query: CPU_RANGE_QUERY, start, end, step } : null,
  );
  const memRange = usePrometheusRange(
    ep ? { context: activeContext, ep, query: MEM_RANGE_QUERY, start, end, step } : null,
  );
  const nsMetrics = usePrometheusInstant(
    ep ? { context: activeContext, ep, query: NS_CPU_QUERY } : null,
  );
  const nsMemMetrics = usePrometheusInstant(
    ep ? { context: activeContext, ep, query: NS_MEM_QUERY } : null,
  );
  const nodeMetrics = usePrometheusInstant(
    ep ? { context: activeContext, ep, query: NODE_CPU_QUERY } : null,
  );
  const customRange = usePrometheusRange(
    ep && customQuery ? { context: activeContext, ep, query: customQuery, start, end, step } : null,
  );

  const cpuChartData = useMemo(() => parseRangeResult(cpuRange.data), [cpuRange.data]);
  const memChartData = useMemo(() => parseRangeResult(memRange.data), [memRange.data]);
  const customChartData = useMemo(() => parseRangeResult(customRange.data), [customRange.data]);

  const nsCpuRows = useMemo(() => parseInstantResult(nsMetrics.data), [nsMetrics.data]);
  const nsMemMap = useMemo(
    () => new Map(parseInstantResult(nsMemMetrics.data).map((r) => [r.label, r.value])),
    [nsMemMetrics.data],
  );
  const nodeCpuRows = useMemo(() => parseInstantResult(nodeMetrics.data), [nodeMetrics.data]);

  if (!ep) {
    return (
      <div className="metrics-tab-content">
        <div className="metrics-prometheus-empty">
          <div className="metrics-prometheus-empty-icon">◎</div>
          <div className="metrics-prometheus-empty-title">Prometheus not detected</div>
          <div className="metrics-prometheus-empty-body">
            Auto-discovery searches for known service names and labels in common namespaces
            (monitoring, prometheus, kube-prometheus-stack, observability, default).
            <br /><br />
            Use the <strong>⚙ Set URL</strong> button to configure a manual Prometheus endpoint.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="metrics-tab-content">
      <div className="metrics-header" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {ep.source === 'manual' ? `Manual: ${ep.url}` : `Auto-discovered: ${ep.namespace}/${ep.service}:${ep.port}`}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Time range:</span>
        <div className="metrics-time-range">
          {(['15m', '1h', '6h', '24h'] as TimeRange[]).map((r) => (
            <button key={r} className={timeRange === r ? 'active' : ''} onClick={() => setTimeRange(r)}>{r}</button>
          ))}
        </div>
      </div>

      {/* Full-width charts */}
      <div className="metrics-charts-row metrics-charts-row-full">
        <div className="metrics-chart-box">
          <div className="metrics-chart-title">Cluster CPU Usage (cores/s)</div>
          <MetricsLineChart
            data={cpuChartData}
            color="var(--accent)"
            formatY={(v) => `${v.toFixed(2)}c`}
            label=""
            loading={cpuRange.isLoading}
            width={580}
            height={140}
          />
        </div>
        <div className="metrics-chart-box">
          <div className="metrics-chart-title">Cluster Memory (Working Set)</div>
          <MetricsLineChart
            data={memChartData}
            color="var(--warning)"
            formatY={(v) => fmtMem(v)}
            label=""
            loading={memRange.isLoading}
            width={580}
            height={140}
          />
        </div>
      </div>

      {/* Namespace + node breakdown */}
      <div className="metrics-bottom-grid metrics-bottom-grid-3col">
        <div className="metrics-table-box metrics-col-span-2">
          <div className="metrics-table-title">Namespace CPU / Memory (instant)</div>
          <table className="metrics-table">
            <thead><tr><th>Namespace</th><th>CPU</th><th>Memory</th></tr></thead>
            <tbody>
              {nsCpuRows.slice(0, 12).map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td>{fmtCpu(Math.round(r.value * 1000))}</td>
                  <td>{fmtMem(nsMemMap.get(r.label) ?? 0)}</td>
                </tr>
              ))}
              {nsCpuRows.length === 0 && (
                <tr><td colSpan={3} className="metrics-cell-dim" style={{ textAlign: 'center' }}>
                  {nsMetrics.isLoading ? 'Loading…' : 'No data'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="metrics-table-box">
          <div className="metrics-table-title">Node CPU (instant)</div>
          <table className="metrics-table">
            <thead><tr><th>Node</th><th>CPU</th></tr></thead>
            <tbody>
              {nodeCpuRows.slice(0, 10).map((r) => (
                <tr key={r.label}>
                  <td className="metrics-cell-truncate">{r.label}</td>
                  <td>{fmtCpu(Math.round(r.value * 1000))}</td>
                </tr>
              ))}
              {nodeCpuRows.length === 0 && (
                <tr><td colSpan={2} className="metrics-cell-dim" style={{ textAlign: 'center' }}>
                  {nodeMetrics.isLoading ? 'Loading…' : 'No data'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Custom PromQL */}
      <div className="metrics-table-box">
        <div className="metrics-table-title">Custom PromQL Query</div>
        <div className="metrics-promql-row">
          <input
            className="metrics-url-input metrics-promql-input"
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            placeholder="e.g. rate(container_cpu_usage_seconds_total[5m])"
            onKeyDown={(e) => { if (e.key === 'Enter') setCustomQuery(queryDraft); }}
          />
          <button className="btn-primary" onClick={() => setCustomQuery(queryDraft)}>Run</button>
          {customQuery && <button className="btn-secondary" onClick={() => { setCustomQuery(''); setQueryDraft(''); }}>Clear</button>}
        </div>
        {customQuery && (
          <div style={{ padding: '0 12px 12px' }}>
            <MetricsLineChart
              data={customChartData}
              color="var(--color-success)"
              formatY={(v) => v.toFixed(3)}
              label={customQuery}
              loading={customRange.isLoading}
              width={900}
              height={140}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function MetricsDashboard() {
  const { activeContext, activeNamespace, setSelectedKind, setSelectedResource } = useAppStore();
  const [tab, setTab] = useState<Tab>('overview');
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');

  const overview = useClusterOverview(activeContext, activeNamespace);
  const discover = usePrometheusDiscover(activeContext);
  const setUrl = useSetPrometheusURL();

  const ep = discover.data?.endpoint ?? null;

  const navToPod = (name: string, namespace: string) => {
    setSelectedKind(new GVR({ group: '', version: 'v1', resource: 'pods' }), 'Pod');
    setSelectedResource(name, namespace);
  };

  const navToResource = useCallback((kind: string, name: string, ns: string) => {
    const gvr = KIND_GVR[kind];
    if (!gvr) return;
    setSelectedKind(new GVR({ group: gvr.group, version: gvr.version, resource: gvr.resource }), gvr.label);
    setSelectedResource(name, ns);
  }, [setSelectedKind, setSelectedResource]);

  const handleSaveUrl = async () => {
    await setUrl.mutateAsync(urlDraft.trim());
    setShowUrlInput(false);
    setUrlDraft('');
  };

  const handleClearUrl = async () => {
    await setUrl.mutateAsync('');
    setShowUrlInput(false);
    setUrlDraft('');
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview',    label: 'Overview' },
    { id: 'nodes',       label: 'Nodes' },
    { id: 'workloads',   label: 'Workloads' },
    { id: 'prometheus',  label: `Prometheus${ep ? ' ✓' : ''}` },
  ];

  return (
    <div className="metrics-dashboard">
      {/* Top toolbar */}
      <div className="metrics-toolbar">
        <div className="metrics-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`metrics-tab-btn ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <span className={badgeClass(ep)}>{badgeLabel(ep)}</span>

        <button
          className="metrics-url-btn"
          onClick={() => { setShowUrlInput((v) => !v); setUrlDraft(ep?.url ?? ''); }}
          title="Set Prometheus URL"
        >
          ⚙ Set URL
        </button>
      </div>

      {/* URL override input */}
      {showUrlInput && (
        <div className="metrics-url-row">
          <input
            className="metrics-url-input"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://prometheus.example.com (empty to clear)"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSaveUrl(); if (e.key === 'Escape') setShowUrlInput(false); }}
            autoFocus
          />
          <button className="btn-primary" onClick={handleSaveUrl}>Save</button>
          <button className="btn-secondary" onClick={handleClearUrl}>Clear</button>
          <button className="btn-secondary" onClick={() => setShowUrlInput(false)}>Cancel</button>
        </div>
      )}

      {/* Tab content */}
      {tab === 'overview' && (
        <OverviewTab overview={overview.data} navToPod={navToPod} navToResource={navToResource} />
      )}
      {tab === 'nodes' && (
        <NodesTab overview={overview.data} activeContext={activeContext} navToPod={navToPod} />
      )}
      {tab === 'workloads' && (
        <WorkloadsTab overview={overview.data} />
      )}
      {tab === 'prometheus' && (
        <PrometheusTab
          ep={ep}
          activeContext={activeContext}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      )}
    </div>
  );
}
