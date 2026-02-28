import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../state/store';
import { useResources, useHelmReleases, useDeleteResource, useUninstallRelease, useRestartResource, useNamespaces } from '../state/queries';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { useClassifyHealth, toPluginResource } from '../plugins';
import { pluginRegistry } from '../plugins/registry';
import { createPluginAPI } from '../plugins/api';

type SortField = 'name' | 'namespace' | 'status' | 'age';
type SortDir = 'asc' | 'desc';

function SortIcon({ field, activeField, dir }: { field: SortField; activeField: SortField; dir: SortDir }) {
  if (field !== activeField) return <span className="sort-icon sort-icon-inactive">{'\u2195'}</span>;
  return <span className="sort-icon sort-icon-active">{dir === 'asc' ? '\u25B2' : '\u25BC'}</span>;
}

import type { HealthCategory } from '../plugins/types';

function statusClass(value: string): string {
  const v = value.toLowerCase();
  if (v === 'running' || v === 'active' || v === 'ready' || v === 'bound' || v === 'available') return 'status-ok';
  if (v === 'succeeded' || v === 'completed') return 'status-ok';
  if (v === 'pending' || v === 'waiting' || v === 'containercreating') return 'status-warn';
  if (v === 'failed' || v === 'error' || v === 'crashloopbackoff' || v === 'imagepullbackoff' || v === 'evicted' || v === 'oomkilled') return 'status-err';
  if (v === 'terminating' || v === 'terminated' || v === 'unknown') return 'status-warn';
  const fractionMatch = value.match(/^(\d+)\/(\d+)$/);
  if (fractionMatch) {
    const [, a, b] = fractionMatch;
    if (a === b && a !== '0') return 'status-ok';
    if (a === '0') return 'status-err';
    return 'status-warn';
  }
  return '';
}

function ReadyBar({ value }: { value: string }) {
  const m = value.match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  const ready = parseInt(m[1]);
  const total = parseInt(m[2]);
  const pct = total > 0 ? (ready / total) * 100 : 0;
  const cls = ready === total && total > 0 ? 'status-ok' : ready === 0 && total > 0 ? 'status-err' : 'status-warn';

  return (
    <span className="ready-bar-wrapper">
      <span className="ready-bar">
        <span className={`ready-bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="ready-bar-label">{value}</span>
    </span>
  );
}

function RestartsIndicator({ count }: { count: string }) {
  const n = parseInt(count);
  if (!n || n <= 0) return null;
  return <span className="restarts-badge" title={`${n} restart${n > 1 ? 's' : ''}`}>{n}↻</span>;
}

function StatusCell({ kind, summary }: { kind: string; summary: { key: string; value: string }[] }) {
  const statusField = summary.find((f) => f.key === 'Status' || f.key === 'Phase');
  const readyField = summary.find((f) => f.key === 'Ready');
  const restartsField = summary.find((f) => f.key === 'Restarts');
  const succeededField = summary.find((f) => f.key === 'Succeeded');
  const typeField = summary.find((f) => f.key === 'Type');

  if (kind === 'Pod') {
    const statusCls = statusField ? statusClass(statusField.value) : '';
    const readyCls = readyField ? statusClass(readyField.value) : '';
    return (
      <span className="col-status status-cell">
        {statusField && (
          <>
            <span className={`status-dot-inline ${statusCls}`} />
            <span className={statusCls}>{statusField.value}</span>
          </>
        )}
        {readyField && <ReadyBar value={readyField.value} />}
        {restartsField && <RestartsIndicator count={restartsField.value} />}
      </span>
    );
  }

  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
    const readyCls = readyField ? statusClass(readyField.value) : '';
    return (
      <span className="col-status status-cell">
        {readyField && (
          <>
            <span className={`status-dot-inline ${readyCls}`} />
            <ReadyBar value={readyField.value} />
          </>
        )}
      </span>
    );
  }

  if (kind === 'Job') {
    const failedField = summary.find((f) => f.key === 'Failed');
    const hasFailed = failedField && parseInt(failedField.value) > 0;
    const cls = hasFailed ? 'status-err' : succeededField && parseInt(succeededField.value) > 0 ? 'status-ok' : 'status-warn';
    const label = hasFailed
      ? `Failed: ${failedField!.value}`
      : `Succeeded: ${succeededField?.value ?? '0'}`;
    return (
      <span className={`col-status status-cell ${cls}`}>
        <span className={`status-dot-inline ${cls}`} />
        {label}
      </span>
    );
  }

  // Service — show Type
  if (kind === 'Service' && typeField) {
    return (
      <span className="col-status status-cell status-ok">
        <span className="status-dot-inline status-ok" />
        {typeField.value}
      </span>
    );
  }

  // Fallback: plain status text
  const fallback = statusField || readyField || summary.find((f) => f.key === 'Phase');
  const cls = fallback ? statusClass(fallback.value) : '';
  return (
    <span className={`col-status status-cell ${cls}`}>
      {cls && <span className={`status-dot-inline ${cls}`} />}
      {fallback?.value || '-'}
    </span>
  );
}

function helmStatusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'deployed') return 'status-ok';
  if (s === 'failed') return 'status-err';
  if (s === 'pending-install' || s === 'pending-upgrade' || s === 'pending-rollback') return 'status-warn';
  if (s === 'uninstalling' || s === 'superseded') return 'status-warn';
  if (s === 'uninstalled') return 'status-err';
  return '';
}

interface MenuState { x: number; y: number; items: ContextMenuItem[] }

function isRbacDeniedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const lower = msg.toLowerCase();
  return lower.includes('forbidden') || lower.includes('permission denied') || lower.includes('rbac');
}

function NamespaceHeader({ nsFilter, setNsFilter }: { nsFilter: Set<string>; setNsFilter: (f: Set<string>) => void }) {
  const { activeContext, setActiveNamespace } = useAppStore();
  const namespaces = useNamespaces(activeContext);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const toggleNs = (ns: string) => {
    const next = new Set(nsFilter);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    setNsFilter(next);
    setActiveNamespace(next.size === 1 ? [...next][0] : '');
  };

  const label = nsFilter.size === 0
    ? 'All namespaces'
    : nsFilter.size === 1
      ? [...nsFilter][0]
      : `${nsFilter.size} namespaces`;

  return (
    <div className="pane-namespace-picker" ref={dropdownRef}>
      <span className="ns-picker-label">Namespace:</span>
      <button
        className={`ns-picker-btn${nsFilter.size > 0 ? ' has-filter' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={!namespaces.data}
      >
        {label} <span className="ns-picker-caret">▾</span>
      </button>
      {open && (
        <div className="ns-picker-dropdown">
          <div
            className={`ns-picker-option${nsFilter.size === 0 ? ' selected' : ''}`}
            onClick={() => { setNsFilter(new Set()); setActiveNamespace(''); setOpen(false); }}
          >
            All namespaces
          </div>
          {namespaces.data?.namespaces.map((ns) => (
            <label key={ns.name} className={`ns-picker-option${nsFilter.has(ns.name) ? ' selected' : ''}`}>
              <input type="checkbox" checked={nsFilter.has(ns.name)} onChange={() => toggleNs(ns.name)} />
              {ns.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function HelmReleaseList() {
  const { activePane, activeContext, activeNamespace, selectedResource, setSelectedResource, readOnly } = useAppStore();
  const [filter, setFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [nsFilter, setNsFilter] = useState<Set<string>>(new Set());
  const helmReleases = useHelmReleases(activeContext, activeNamespace);
  const uninstall = useUninstallRelease();
  const isFocused = activePane === 'list';
  const helmTableRef = useRef<HTMLDivElement>(null);

  // Arrow key navigation when the list pane is focused.
  useEffect(() => {
    if (!isFocused) return;
    const handler = (e: Event) => {
      const dir = (e as CustomEvent<'up' | 'down'>).detail;
      setFilter(''); // clear filter so all rows visible during keyboard nav
      const list = helmReleases.data?.releases ?? [];
      if (!list.length) return;
      const currentIdx = list.findIndex((r) => r.name === selectedResource);
      const nextIdx = dir === 'down'
        ? (currentIdx < 0 ? 0 : Math.min(currentIdx + 1, list.length - 1))
        : (currentIdx < 0 ? 0 : Math.max(currentIdx - 1, 0));
      const next = list[nextIdx];
      if (next) {
        setSelectedResource(next.name, next.namespace);
        setTimeout(() => {
          helmTableRef.current?.querySelector('.table-row.selected')?.scrollIntoView({ block: 'nearest' });
        }, 0);
      }
    };
    window.addEventListener('pane-navigate', handler);
    return () => window.removeEventListener('pane-navigate', handler);
  }, [isFocused, helmReleases.data?.releases, selectedResource, setSelectedResource]);

  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }, [sortField]);

  const filtered = useMemo(() => {
    if (!helmReleases.data?.releases) return [];
    let list = helmReleases.data.releases;
    if (filter) {
      const f = filter.toLowerCase();
      list = list.filter((r) => r.name.toLowerCase().includes(f));
    }
    if (nsFilter.size > 0) {
      list = list.filter((r) => nsFilter.has(r.namespace));
    }
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'namespace': cmp = a.namespace.localeCompare(b.namespace); break;
        case 'status': cmp = a.status.localeCompare(b.status); break;
        case 'age': cmp = `${a.chart}-${a.chartVersion}`.localeCompare(`${b.chart}-${b.chartVersion}`); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [helmReleases.data, filter, sortField, sortDir, nsFilter]);

  return (
    <div className={`pane resource-list-pane ${isFocused ? 'focused' : ''}`}>
      <div className="pane-header">
        <NamespaceHeader nsFilter={nsFilter} setNsFilter={setNsFilter} />
      </div>
      <div className="resource-list">
        <div className="list-header">
          <span className="list-title">Helm Releases</span>
          <input
            className="list-filter"
            type="text"
            placeholder="Filter by name..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="list-count">{filtered.length} items</span>
        </div>
        {helmReleases.isError ? (
          <div className="resource-list-error">
            <div className="error-message">
              Failed to load Helm releases: {helmReleases.error instanceof Error ? helmReleases.error.message : 'Unknown error'}
            </div>
            <button className="retry-btn" onClick={() => helmReleases.refetch()}>Retry</button>
          </div>
        ) : (
          <div className="list-table">
            <div className="table-header">
              <span className="col-name sortable-col" onClick={() => toggleSort('name')}>Name <SortIcon field="name" activeField={sortField} dir={sortDir} /></span>
              <span className="col-namespace sortable-col" onClick={() => toggleSort('namespace')}>Namespace <SortIcon field="namespace" activeField={sortField} dir={sortDir} /></span>
              <span className="col-status sortable-col" onClick={() => toggleSort('status')}>Status <SortIcon field="status" activeField={sortField} dir={sortDir} /></span>
              <span className="col-age sortable-col" onClick={() => toggleSort('age')}>Chart <SortIcon field="age" activeField={sortField} dir={sortDir} /></span>
            </div>
            <div className="table-body" ref={helmTableRef}>
              {helmReleases.isLoading && <div className="loading">Loading...</div>}
              {filtered.map((rel) => {
                const cls = helmStatusClass(rel.status);
                return (
                  <div
                    key={`${rel.namespace}/${rel.name}`}
                    className={`table-row ${selectedResource === rel.name ? 'selected' : ''}`}
                    onClick={() => setSelectedResource(rel.name, rel.namespace)}
                    onDoubleClick={() => {
                      setSelectedResource(rel.name, rel.namespace);
                      useAppStore.getState().setActivePane('inspector');
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelectedResource(rel.name, rel.namespace);
                      const helmTab = (tab: string) => {
                        useAppStore.getState().setActivePane('inspector');
                        window.dispatchEvent(new CustomEvent('set-inspector-tab', { detail: tab }));
                      };
                      setMenu({
                        x: e.clientX, y: e.clientY,
                        items: [
                          { label: 'Summary', onClick: () => helmTab('summary') },
                          { label: 'Values', onClick: () => helmTab('values') },
                          { label: 'History', onClick: () => helmTab('history') },
                          { separator: true },
                          {
                            label: 'Uninstall',
                            danger: true,
                            disabled: readOnly,
                            onClick: () => {
                              if (confirm(`Uninstall "${rel.name}"?`)) {
                                uninstall.mutate({ context: activeContext, namespace: rel.namespace, name: rel.name });
                              }
                            },
                          },
                        ],
                      });
                    }}
                  >
                    <span className="col-name">{rel.name}</span>
                    <span className="col-namespace">{rel.namespace}</span>
                    <span className={`col-status status-cell ${cls}`}>
                      {cls && <span className={`status-dot-inline ${cls}`} />}
                      {rel.status}
                    </span>
                    <span className="col-age">{rel.chart}-{rel.chartVersion}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function getStatusText(summary: { key: string; value: string }[]): string {
  const status = summary.find((f) => f.key === 'Status' || f.key === 'Phase');
  if (status) return status.value;
  const ready = summary.find((f) => f.key === 'Ready');
  if (ready) return ready.value;
  return '';
}

function healthOrder(cat: HealthCategory): number {
  return cat === 'err' ? 0 : cat === 'warn' ? 1 : 2;
}

const SCALABLE_KINDS = new Set(['Deployment', 'StatefulSet', 'ReplicaSet']);
const RESTARTABLE_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

export function ResourceList() {
  const { activePane, activeContext, activeNamespace, selectedKind, selectedKindLabel, selectedResource, selectedResourceNamespace, setSelectedResource, readOnly } =
    useAppStore();
  const [filter, setFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [healthFilter, setHealthFilter] = useState<HealthCategory | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set()); // "ns/name"
  const [nsFilter, setNsFilter] = useState<Set<string>>(new Set());
  const resources = useResources(activeContext, activeNamespace, selectedKind, filter);
  const deleteMutation = useDeleteResource();
  const restartMutation = useRestartResource();
  const isFocused = activePane === 'list';

  // Tick every 60s so age column updates without a full refetch.
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAgeTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const classifyHealth = useClassifyHealth();
  const tableBodyRef = useRef<HTMLDivElement>(null);
  const pluginApi = useMemo(() => createPluginAPI('@truss/builtin'), []);

  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'age' ? 'desc' : 'asc');
    }
  }, [sortField]);

  // Compute health distribution (must be before any early returns to satisfy React hooks rules)
  const healthCounts = useMemo(() => {
    if (!resources.data?.resources) return { ok: 0, warn: 0, err: 0 };
    const counts = { ok: 0, warn: 0, err: 0 };
    for (const res of resources.data.resources) {
      counts[classifyHealth(toPluginResource(res, selectedKind))]++;
    }
    return counts;
  }, [resources.data, classifyHealth, selectedKind]);

  // Reset health filter and multi-selection when the resource kind changes.
  React.useEffect(() => { setHealthFilter(null); setMultiSelected(new Set()); }, [selectedKind]);

  const sortedResources = useMemo(() => {
    if (!resources.data?.resources) return [];
    const base = healthFilter
      ? resources.data.resources.filter((r) => classifyHealth(toPluginResource(r, selectedKind)) === healthFilter)
      : resources.data.resources;
    return [...base].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name':
          cmp = (a.metadata?.name || '').localeCompare(b.metadata?.name || '');
          break;
        case 'namespace':
          cmp = (a.metadata?.namespace || '').localeCompare(b.metadata?.namespace || '');
          break;
        case 'status':
          cmp = healthOrder(classifyHealth(toPluginResource(a, selectedKind))) - healthOrder(classifyHealth(toPluginResource(b, selectedKind)));
          if (cmp === 0) cmp = getStatusText(a.summary).localeCompare(getStatusText(b.summary));
          break;
        case 'age': {
          const ta = a.metadata?.creationTimestamp || '';
          const tb = b.metadata?.creationTimestamp || '';
          cmp = ta.localeCompare(tb);
          break;
        }
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [resources.data, sortField, sortDir, healthFilter, classifyHealth, selectedKind]);

  // Client-side namespace filter applied on top of sorted results.
  const displayedResources = useMemo(() => {
    if (nsFilter.size === 0) return sortedResources;
    return sortedResources.filter((r) => nsFilter.has(r.metadata?.namespace || ''));
  }, [sortedResources, nsFilter]);

  const handleBulkDelete = useCallback(() => {
    if (!selectedKind || multiSelected.size === 0) return;
    if (!confirm(`Delete ${multiSelected.size} resource${multiSelected.size > 1 ? 's' : ''}?`)) return;
    for (const key of multiSelected) {
      const slash = key.indexOf('/');
      const ns = key.slice(0, slash);
      const name = key.slice(slash + 1);
      deleteMutation.mutate({ context: activeContext, namespace: ns, gvr: selectedKind, name });
    }
    setMultiSelected(new Set());
  }, [multiSelected, selectedKind, activeContext, deleteMutation]);

  const handleBulkRestart = useCallback(() => {
    if (!selectedKind || multiSelected.size === 0) return;
    if (!confirm(`Restart ${multiSelected.size} resource${multiSelected.size > 1 ? 's' : ''}?`)) return;
    for (const key of multiSelected) {
      const slash = key.indexOf('/');
      const ns = key.slice(0, slash);
      const name = key.slice(slash + 1);
      restartMutation.mutate({ context: activeContext, namespace: ns, gvr: selectedKind, name });
    }
    setMultiSelected(new Set());
  }, [multiSelected, selectedKind, activeContext, restartMutation]);

  // Arrow key navigation when the list pane is focused (dispatched from App.tsx).
  useEffect(() => {
    if (!isFocused) return;
    const handler = (e: Event) => {
      const dir = (e as CustomEvent<'up' | 'down'>).detail;
      if (!displayedResources.length) return;
      const currentIdx = displayedResources.findIndex((r) => r.metadata?.name === selectedResource && r.metadata?.namespace === selectedResourceNamespace);
      const nextIdx = dir === 'down'
        ? (currentIdx < 0 ? 0 : Math.min(currentIdx + 1, displayedResources.length - 1))
        : (currentIdx < 0 ? 0 : Math.max(currentIdx - 1, 0));
      const next = displayedResources[nextIdx];
      if (next) {
        setMultiSelected(new Set());
        setSelectedResource(next.metadata?.name ?? '', next.metadata?.namespace ?? '');
        setTimeout(() => {
          tableBodyRef.current?.querySelector('.table-row.selected')?.scrollIntoView({ block: 'nearest' });
        }, 0);
      }
    };

    const delHandler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;

      if (e.key === 'Escape') {
        if (multiSelected.size > 0) { e.preventDefault(); setMultiSelected(new Set()); }
        return;
      }

      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!selectedKind) return;
      e.preventDefault();
      if (multiSelected.size > 1) {
        handleBulkDelete();
      } else if (selectedResource) {
        if (confirm(`Delete "${selectedResource}"?`)) {
          deleteMutation.mutate({ context: activeContext, namespace: selectedResourceNamespace, gvr: selectedKind, name: selectedResource });
        }
      }
    };

    window.addEventListener('pane-navigate', handler);
    window.addEventListener('keydown', delHandler);
    return () => {
      window.removeEventListener('pane-navigate', handler);
      window.removeEventListener('keydown', delHandler);
    };
  }, [isFocused, displayedResources, selectedResource, selectedResourceNamespace, setSelectedResource, multiSelected, handleBulkDelete, selectedKind, activeContext, deleteMutation]);

  if (selectedKindLabel === 'Helm Releases') {
    return <HelmReleaseList />;
  }

  if (!selectedKind) {
    return (
      <div className={`pane resource-list-pane ${isFocused ? 'focused' : ''}`}>
        <div className="pane-header">
          <NamespaceHeader nsFilter={nsFilter} setNsFilter={setNsFilter} />
        </div>
        <div className="resource-list empty">Select a resource kind from the tree</div>
      </div>
    );
  }

  return (
    <div className={`pane resource-list-pane ${isFocused ? 'focused' : ''}`}>
      <div className="pane-header">
        <NamespaceHeader nsFilter={nsFilter} setNsFilter={setNsFilter} />
      </div>
      <div className="resource-list">
        <div className="list-header">
          <span className="list-title">{selectedKindLabel}</span>
          <input
            className="list-filter"
            type="text"
            placeholder="Filter by name..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {resources.data && (
            <>
              <span className="health-summary">
                {healthCounts.ok > 0 && (
                  <span
                    className={`health-chip health-ok${healthFilter === 'ok' ? ' active' : ''}`}
                    onClick={() => setHealthFilter((f) => f === 'ok' ? null : 'ok')}
                    title="Filter: healthy"
                  >
                    <span className="health-chip-dot" />
                    {healthCounts.ok}
                  </span>
                )}
                {healthCounts.warn > 0 && (
                  <span
                    className={`health-chip health-warn${healthFilter === 'warn' ? ' active' : ''}`}
                    onClick={() => setHealthFilter((f) => f === 'warn' ? null : 'warn')}
                    title="Filter: warning"
                  >
                    <span className="health-chip-dot" />
                    {healthCounts.warn}
                  </span>
                )}
                {healthCounts.err > 0 && (
                  <span
                    className={`health-chip health-err${healthFilter === 'err' ? ' active' : ''}`}
                    onClick={() => setHealthFilter((f) => f === 'err' ? null : 'err')}
                    title="Filter: error"
                  >
                    <span className="health-chip-dot" />
                    {healthCounts.err}
                  </span>
                )}
              </span>
              <span className="list-count">{displayedResources.length}/{resources.data.totalCount}</span>
            </>
          )}
        </div>
        {resources.isError ? (
          <div className="resource-list-error">
            <div className="error-message">
              Failed to load resources: {resources.error instanceof Error ? resources.error.message : 'Unknown error'}
            </div>
            {isRbacDeniedError(resources.error) && (
              <div className="error-message" style={{ marginTop: 8, opacity: 0.85 }}>
                RBAC likely denied access to list {selectedKindLabel}. Ask for `list` permission on this resource in
                {activeNamespace ? ` namespace "${activeNamespace}"` : ' the selected scope'}.
              </div>
            )}
            <button className="retry-btn" onClick={() => resources.refetch()}>Retry</button>
          </div>
        ) : (
          <div className="list-table">
            <div className="table-header">
              <span className="col-name sortable-col" onClick={() => toggleSort('name')}>Name <SortIcon field="name" activeField={sortField} dir={sortDir} /></span>
              <span className="col-namespace sortable-col" onClick={() => toggleSort('namespace')}>Namespace <SortIcon field="namespace" activeField={sortField} dir={sortDir} /></span>
              <span className="col-status sortable-col" onClick={() => toggleSort('status')}>Status <SortIcon field="status" activeField={sortField} dir={sortDir} /></span>
              <span className="col-age sortable-col" onClick={() => toggleSort('age')}>Age <SortIcon field="age" activeField={sortField} dir={sortDir} /></span>
            </div>
            <div className="table-body" ref={tableBodyRef}>
              {resources.isLoading && <div className="loading">Loading...</div>}
              {!resources.isLoading && resources.data && sortedResources.length === 0 && (
                <div className="resource-list empty">
                  <div>No {selectedKindLabel.toLowerCase()} found.</div>
                  <div style={{ marginTop: 8, opacity: 0.8 }}>
                    This may be normal for the selected namespace/filter. If you expected results, check your RBAC
                    permissions (`list` on {selectedKindLabel}).
                  </div>
                </div>
              )}
              {displayedResources.map((res) => {
                const podStartedAt = selectedKindLabel === 'Pod' ? (res.summary.find((f) => f.key === 'StartedAt')?.value || '') : '';
                const age = formatAge(podStartedAt || res.metadata?.creationTimestamp || '');
                const resName = res.metadata?.name || '';
                const resNs = res.metadata?.namespace || '';
                const rowKey = `${resNs}/${resName}`;
                const isSelected = selectedResource === resName && selectedResourceNamespace === resNs;
                const isHighlighted = !isSelected && selectedResource === resName;
                const isMultiSelected = multiSelected.has(rowKey);

                return (
                  <div
                    key={res.metadata?.uid}
                    className={`table-row${isSelected ? ' selected' : ''}${isHighlighted ? ' highlighted' : ''}${isMultiSelected ? ' multi-selected' : ''}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) e.preventDefault();
                      if (e.metaKey || e.ctrlKey) {
                        setMultiSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
                          // Keep primary selection in the set too
                          if (selectedResource) next.add(`${selectedResourceNamespace}/${selectedResource}`);
                          return next;
                        });
                      } else if (e.shiftKey && selectedResource) {
                        const curIdx = displayedResources.findIndex((r) => r.metadata?.name === selectedResource && r.metadata?.namespace === selectedResourceNamespace);
                        const clickIdx = displayedResources.indexOf(res);
                        if (curIdx >= 0) {
                          const [start, end] = [Math.min(curIdx, clickIdx), Math.max(curIdx, clickIdx)];
                          setMultiSelected(new Set(displayedResources.slice(start, end + 1).map((r) => `${r.metadata?.namespace || ''}/${r.metadata?.name || ''}`)));
                        }
                      } else {
                        setMultiSelected(new Set());
                        setSelectedResource(resName, resNs);
                      }
                    }}
                    onDoubleClick={() => {
                      setMultiSelected(new Set());
                      setSelectedResource(resName, resNs);
                      useAppStore.getState().setActivePane('inspector');
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!isMultiSelected) {
                        setMultiSelected(new Set());
                        setSelectedResource(resName, resNs);
                      }
                      const kind = selectedKindLabel;
                      const isRestartable = RESTARTABLE_KINDS.has(kind);
                      const isScalable = SCALABLE_KINDS.has(kind);
                      const inspectTab = (tab: string) => {
                        useAppStore.getState().setActivePane('inspector');
                        window.dispatchEvent(new CustomEvent('set-inspector-tab', { detail: tab }));
                      };
                      const pluginRes = toPluginResource(res, selectedKind);
                      const items: ContextMenuItem[] = [
                        { label: 'Data', onClick: () => inspectTab('edit') },
                        { label: 'YAML', onClick: () => inspectTab('yaml') },
                        { label: 'Events', onClick: () => inspectTab('events') },
                      ];

                      // Append plugin context menu items (builtin podActions adds Logs/Exec for Pods).
                      const pluginItems = pluginRegistry.contextMenuItems.filter((item) => {
                        if (item.kinds && !item.kinds.includes(kind)) return false;
                        if (item.isAvailable && !item.isAvailable(pluginRes)) return false;
                        return true;
                      });
                      if (pluginItems.length > 0) {
                        items.push({ separator: true });
                        for (const pluginItem of pluginItems) {
                          items.push({
                            label: pluginItem.label,
                            danger: pluginItem.isDanger,
                            onClick: () => pluginItem.onClick(pluginRes, pluginApi),
                          });
                        }
                      }

                      if (isScalable || isRestartable) {
                        items.push({ separator: true });
                        if (isScalable) {
                          items.push({
                            label: 'Scale...',
                            disabled: readOnly,
                            onClick: () => {
                              const input = prompt(`Scale "${resName}" — enter replica count:`);
                              if (input === null) return;
                              const n = parseInt(input, 10);
                              if (!isNaN(n) && n >= 0 && selectedKind) {
                                // Trigger via inspector tab switch + scale dialog is complex;
                                // dispatch a custom event the inspector already listens to
                                window.dispatchEvent(new CustomEvent('open-scale-dialog', { detail: { name: resName, namespace: resNs, replicas: n } }));
                              }
                            },
                          });
                        }
                        if (isRestartable) {
                          items.push({
                            label: 'Restart',
                            disabled: readOnly,
                            onClick: () => {
                              if (confirm(`Restart "${resName}"?`) && selectedKind) {
                                restartMutation.mutate({ context: activeContext, namespace: resNs, gvr: selectedKind, name: resName });
                              }
                            },
                          });
                        }
                      }
                      if (multiSelected.size > 1 && isMultiSelected) {
                        // Bulk actions when right-clicking inside an active multi-selection
                        items.push({ separator: true });
                        if (RESTARTABLE_KINDS.has(selectedKindLabel)) {
                          items.push({
                            label: `Restart ${multiSelected.size} selected`,
                            disabled: readOnly,
                            onClick: handleBulkRestart,
                          });
                        }
                        items.push({
                          label: `Delete ${multiSelected.size} selected`,
                          danger: true,
                          disabled: readOnly,
                          onClick: handleBulkDelete,
                        });
                      } else {
                        items.push({ separator: true });
                        items.push({
                          label: 'Delete',
                          danger: true,
                          disabled: readOnly,
                          onClick: () => {
                            if (confirm(`Delete "${resName}"?`) && selectedKind) {
                              deleteMutation.mutate({ context: activeContext, namespace: resNs, gvr: selectedKind, name: resName });
                            }
                          },
                        });
                      }
                      setMenu({ x: e.clientX, y: e.clientY, items });
                    }}
                  >
                    <span className="col-name">{res.metadata?.name}</span>
                    <span className="col-namespace">{res.metadata?.namespace || '-'}</span>
                    <StatusCell kind={selectedKindLabel} summary={res.summary} />
                    <span className="col-age">{age}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {multiSelected.size > 1 && (
        <div className="bulk-action-bar">
          <span className="bulk-count">{multiSelected.size} selected</span>
          {RESTARTABLE_KINDS.has(selectedKindLabel) && (
            <button className="bulk-btn" disabled={readOnly} onClick={handleBulkRestart}>
              Restart {multiSelected.size}
            </button>
          )}
          <button className="bulk-btn danger" disabled={readOnly} onClick={handleBulkDelete}>
            Delete {multiSelected.size}
          </button>
          <button className="bulk-btn" onClick={() => setMultiSelected(new Set())}>
            Clear (Esc)
          </button>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
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
