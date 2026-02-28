import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useAppStore } from '../state/store';
import { useContexts, useSetActiveContext, useNamespaces } from '../state/queries';
import { fetchSetupAPI } from '../api/client';
import { GVR } from '../api/gen/truss/v1/resources_pb';
import { useToast } from '../hooks/useToast';

type PaletteMode = 'command' | 'search';

interface CommandDef {
  aliases: string[];
  label: string;
  description: string;
  action: 'selectKind' | 'pickNamespace' | 'pickContext' | 'openPortForward';
  gvr?: { group: string; version: string; resource: string; kind: string };
}

const COMMANDS: CommandDef[] = [
  { aliases: ['ns', 'namespace'], label: ':ns', description: 'Switch namespace', action: 'pickNamespace' },
  { aliases: ['ctx', 'context'], label: ':ctx', description: 'Switch context', action: 'pickContext' },
  { aliases: ['pf', 'portforward', 'forward'], label: ':pf', description: 'Open port-forward manager', action: 'openPortForward' },
  { aliases: ['pod', 'pods'], label: ':pod', description: 'Pods', action: 'selectKind', gvr: { group: '', version: 'v1', resource: 'pods', kind: 'Pod' } },
  { aliases: ['pmetrics', 'podmetrics'], label: ':pmetrics', description: 'Pod Metrics', action: 'selectKind', gvr: { group: 'metrics.k8s.io', version: 'v1beta1', resource: 'pods', kind: 'PodMetrics' } },
  { aliases: ['nmetrics', 'nodemetrics'], label: ':nmetrics', description: 'Node Metrics', action: 'selectKind', gvr: { group: 'metrics.k8s.io', version: 'v1beta1', resource: 'nodes', kind: 'NodeMetrics' } },
  { aliases: ['deploy', 'deployment'], label: ':deploy', description: 'Deployments', action: 'selectKind', gvr: { group: 'apps', version: 'v1', resource: 'deployments', kind: 'Deployment' } },
  { aliases: ['svc', 'service'], label: ':svc', description: 'Services', action: 'selectKind', gvr: { group: '', version: 'v1', resource: 'services', kind: 'Service' } },
  { aliases: ['cm', 'configmap'], label: ':cm', description: 'ConfigMaps', action: 'selectKind', gvr: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap' } },
  { aliases: ['secret', 'secrets'], label: ':secret', description: 'Secrets', action: 'selectKind', gvr: { group: '', version: 'v1', resource: 'secrets', kind: 'Secret' } },
  { aliases: ['sts', 'statefulset'], label: ':sts', description: 'StatefulSets', action: 'selectKind', gvr: { group: 'apps', version: 'v1', resource: 'statefulsets', kind: 'StatefulSet' } },
  { aliases: ['ds', 'daemonset'], label: ':ds', description: 'DaemonSets', action: 'selectKind', gvr: { group: 'apps', version: 'v1', resource: 'daemonsets', kind: 'DaemonSet' } },
  { aliases: ['ing', 'ingress'], label: ':ing', description: 'Ingresses', action: 'selectKind', gvr: { group: 'networking.k8s.io', version: 'v1', resource: 'ingresses', kind: 'Ingress' } },
  { aliases: ['job', 'jobs'], label: ':job', description: 'Jobs', action: 'selectKind', gvr: { group: 'batch', version: 'v1', resource: 'jobs', kind: 'Job' } },
  { aliases: ['cj', 'cronjob'], label: ':cj', description: 'CronJobs', action: 'selectKind', gvr: { group: 'batch', version: 'v1', resource: 'cronjobs', kind: 'CronJob' } },
  { aliases: ['no', 'node'], label: ':no', description: 'Nodes', action: 'selectKind', gvr: { group: '', version: 'v1', resource: 'nodes', kind: 'Node' } },
  { aliases: ['pv'], label: ':pv', description: 'PersistentVolumes', action: 'selectKind', gvr: { group: '', version: 'v1', resource: 'persistentvolumes', kind: 'PersistentVolume' } },
  { aliases: ['pvc'], label: ':pvc', description: 'PersistentVolumeClaims', action: 'selectKind', gvr: { group: '', version: 'v1', resource: 'persistentvolumeclaims', kind: 'PersistentVolumeClaim' } },
  { aliases: ['sa', 'serviceaccount'], label: ':sa', description: 'ServiceAccounts', action: 'selectKind', gvr: { group: '', version: 'v1', resource: 'serviceaccounts', kind: 'ServiceAccount' } },
  { aliases: ['hpa'], label: ':hpa', description: 'HorizontalPodAutoscalers', action: 'selectKind', gvr: { group: 'autoscaling', version: 'v2', resource: 'horizontalpodautoscalers', kind: 'HorizontalPodAutoscaler' } },
  { aliases: ['ev', 'event'], label: ':ev', description: 'Events', action: 'selectKind', gvr: { group: '', version: 'v1', resource: 'events', kind: 'Event' } },
  { aliases: ['rs', 'replicaset'], label: ':rs', description: 'ReplicaSets', action: 'selectKind', gvr: { group: 'apps', version: 'v1', resource: 'replicasets', kind: 'ReplicaSet' } },
  { aliases: ['sc', 'storageclass'], label: ':sc', description: 'StorageClasses', action: 'selectKind', gvr: { group: 'storage.k8s.io', version: 'v1', resource: 'storageclasses', kind: 'StorageClass' } },
  { aliases: ['role'], label: ':role', description: 'Roles', action: 'selectKind', gvr: { group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'roles', kind: 'Role' } },
  { aliases: ['rolebinding'], label: ':rolebinding', description: 'RoleBindings', action: 'selectKind', gvr: { group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'rolebindings', kind: 'RoleBinding' } },
  { aliases: ['clusterrole'], label: ':clusterrole', description: 'ClusterRoles', action: 'selectKind', gvr: { group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'clusterroles', kind: 'ClusterRole' } },
  { aliases: ['clusterrolebinding'], label: ':clusterrolebinding', description: 'ClusterRoleBindings', action: 'selectKind', gvr: { group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'clusterrolebindings', kind: 'ClusterRoleBinding' } },
  { aliases: ['crd'], label: ':crd', description: 'CustomResourceDefinitions', action: 'selectKind', gvr: { group: 'apiextensions.k8s.io', version: 'v1', resource: 'customresourcedefinitions', kind: 'CustomResourceDefinition' } },
];

const ALIAS_MAP = new Map<string, CommandDef>();
for (const cmd of COMMANDS) {
  for (const alias of cmd.aliases) {
    ALIAS_MAP.set(alias, cmd);
  }
}

function parseInput(raw: string): { cmdText: string; arg: string | undefined; matchedCmd: CommandDef | undefined } {
  const text = raw.replace(/^:/, '');
  const spaceIdx = text.indexOf(' ');
  if (spaceIdx === -1) {
    return { cmdText: text, arg: undefined, matchedCmd: undefined };
  }
  const cmdText = text.slice(0, spaceIdx);
  const arg = text.slice(spaceIdx + 1);
  const matchedCmd = ALIAS_MAP.get(cmdText.toLowerCase());
  return { cmdText, arg, matchedCmd };
}

interface ListItem {
  id: string;
  label: string;
  description: string;
}

interface SearchResult {
  id: string;
  name: string;
  namespace: string;
  kind: string;
  group: string;
  version: string;
  resource: string;
}

interface Props {
  open: boolean;
  mode?: PaletteMode;
  onClose: () => void;
}

export function CommandPalette({ open, mode = 'command', onClose }: Props) {
  const addToast = useToast((s) => s.addToast);
  const [input, setInput] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchCacheWarming, setSearchCacheWarming] = useState(false);
  const [searchCacheAgeMs, setSearchCacheAgeMs] = useState(0);
  const [showSearchCacheStatus, setShowSearchCacheStatus] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchSeqRef = useRef(0);
  const hideCacheStatusTimerRef = useRef<number | null>(null);

  const {
    activeContext,
    activeNamespace,
    selectedKindLabel,
    selectedResource,
    setActiveContext,
    setActiveNamespace,
    setSelectedKind,
    setSelectedResource,
    setActivePane,
  } = useAppStore();

  const contexts = useContexts();
  const setContextMutation = useSetActiveContext();
  const namespaces = useNamespaces(activeContext);

  useEffect(() => {
    if (!open) return;
    setInput('');
    setSelectedIndex(0);
    setSearchResults([]);
    setSearchLoading(false);
    setSearchCacheWarming(false);
    setSearchCacheAgeMs(0);
    setShowSearchCacheStatus(false);
    if (hideCacheStatusTimerRef.current) {
      window.clearTimeout(hideCacheStatusTimerRef.current);
      hideCacheStatusTimerRef.current = null;
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, mode]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.cmd-palette-item');
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const parsed = useMemo(() => parseInput(input), [input]);
  const inArgMode = mode === 'command' && parsed.arg !== undefined && parsed.matchedCmd !== undefined;

  useEffect(() => {
    if (!open || mode !== 'search') return;

    const q = input.trim().toLowerCase();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    const seq = ++searchSeqRef.current;
    const timer = window.setTimeout(async () => {
      if (!activeContext) {
        setSearchResults([]);
        setSearchLoading(false);
        return;
      }

      setSearchLoading(true);

      try {
        const resp = await fetchSetupAPI(
          `/api/search/resources?context=${encodeURIComponent(activeContext)}&q=${encodeURIComponent(q)}&limit=200`,
        );
        if (!resp.ok) {
          throw new Error(`search failed: ${resp.status}`);
        }
        const payload = await resp.json() as {
          warming?: boolean;
          index_age_ms?: number;
          results?: Array<{
            name?: string;
            namespace?: string;
            kind?: string;
            group?: string;
            version?: string;
            resource?: string;
          }>;
        };
        if (seq !== searchSeqRef.current) return;
        const warming = !!payload.warming;
        const ageMs = typeof payload.index_age_ms === 'number' ? payload.index_age_ms : 0;
        setSearchCacheWarming(warming);
        setSearchCacheAgeMs(ageMs);
        setShowSearchCacheStatus(true);
        if (hideCacheStatusTimerRef.current) {
          window.clearTimeout(hideCacheStatusTimerRef.current);
          hideCacheStatusTimerRef.current = null;
        }
        if (!warming) {
          hideCacheStatusTimerRef.current = window.setTimeout(() => {
            setShowSearchCacheStatus(false);
            hideCacheStatusTimerRef.current = null;
          }, 2800);
        }
        const results = (payload.results ?? []).map((r) => {
          const name = r.name ?? '';
          const namespace = r.namespace ?? '';
          const group = r.group ?? '';
          const version = r.version ?? '';
          const resource = r.resource ?? '';
          return {
            id: `${group}/${version}/${resource}:${namespace}:${name}`,
            name,
            namespace,
            kind: r.kind ?? '',
            group,
            version,
            resource,
          };
        });
        setSearchResults(results);
      } catch (err) {
        if (seq === searchSeqRef.current) {
          addToast('warning', 'Search unavailable — index may still be warming up');
          setSearchResults([]);
        }
      } finally {
        if (seq === searchSeqRef.current) {
          setSearchLoading(false);
        }
      }
    }, 150);

    return () => window.clearTimeout(timer);
  }, [open, mode, input, activeContext]);

  const filteredCommands = useMemo(() => {
    if (mode !== 'command' || inArgMode) return [];
    const q = input.toLowerCase().replace(/^:/, '');
    if (!q) return COMMANDS;
    return COMMANDS.filter(
      (cmd) =>
        cmd.aliases.some((a) => a.startsWith(q)) ||
        cmd.description.toLowerCase().includes(q),
    );
  }, [mode, input, inArgMode]);

  const filteredNamespaces = useMemo((): ListItem[] => {
    if (mode !== 'command' || !inArgMode || parsed.matchedCmd!.action !== 'pickNamespace') return [];
    const list = namespaces.data?.namespaces ?? [];
    const q = (parsed.arg ?? '').toLowerCase();
    const all: ListItem = { id: '', label: 'All namespaces', description: '' };
    const items: ListItem[] = [all, ...list.map((ns) => ({ id: ns.name, label: ns.name, description: '' }))];
    if (!q) return items;
    return items.filter(
      (it) => it.id === '' ? 'all namespaces'.includes(q) : it.id.toLowerCase().includes(q),
    );
  }, [mode, inArgMode, parsed.matchedCmd, parsed.arg, namespaces.data]);

  const filteredContexts = useMemo((): ListItem[] => {
    if (mode !== 'command' || !inArgMode || parsed.matchedCmd!.action !== 'pickContext') return [];
    const list = contexts.data?.contexts ?? [];
    const q = (parsed.arg ?? '').toLowerCase();
    const items: ListItem[] = list.map((ctx) => ({
      id: ctx.name,
      label: ctx.name,
      description: ctx.isActive ? '(active)' : '',
    }));
    if (!q) return items;
    return items.filter((it) => it.id.toLowerCase().includes(q));
  }, [mode, inArgMode, parsed.matchedCmd, parsed.arg, contexts.data]);

  const currentItems = useMemo((): ListItem[] => {
    if (mode === 'search') {
      return searchResults.map((result) => ({
        id: result.id,
        label: result.name,
        description: `${result.kind || result.resource} | ${result.namespace || 'cluster-scoped'}`,
      }));
    }

    if (!inArgMode) {
      return filteredCommands.map((c) => ({
        id: c.label,
        label: c.label,
        description: c.description,
      }));
    }

    const cmd = parsed.matchedCmd!;
    if (cmd.action === 'pickNamespace') return filteredNamespaces;
    if (cmd.action === 'pickContext') return filteredContexts;
    return [{ id: '__exec__', label: cmd.description, description: 'Press Enter to select' }];
  }, [mode, searchResults, inArgMode, filteredCommands, parsed.matchedCmd, filteredNamespaces, filteredContexts]);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, currentItems.length - 1)));
  }, [currentItems.length]);

  const doSelectKind = useCallback(
    (cmd: CommandDef) => {
      if (!cmd.gvr) return;
      const gvr = new GVR({ group: cmd.gvr.group, version: cmd.gvr.version, resource: cmd.gvr.resource });
      setSelectedKind(gvr, cmd.gvr.kind);
      onClose();
    },
    [setSelectedKind, onClose],
  );

  const doOpenPortForward = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.openPortForwardWindow) return;
    api.openPortForwardWindow({
      context: activeContext,
      namespace: activeNamespace,
      targetType: 'pod',
      targetName: selectedKindLabel === 'Pod' ? selectedResource : '',
    });
    onClose();
  }, [activeContext, activeNamespace, selectedKindLabel, selectedResource, onClose]);

  const doSelectNamespace = useCallback(
    (name: string) => {
      setActiveNamespace(name);
      onClose();
    },
    [setActiveNamespace, onClose],
  );

  const doSelectContext = useCallback(
    (name: string) => {
      setActiveContext(name);
      setContextMutation.mutate(name);
      onClose();
    },
    [setActiveContext, setContextMutation, onClose],
  );

  const doSelectSearchResult = useCallback(
    (result: SearchResult) => {
      setActiveNamespace(result.namespace || '');
      const gvr = new GVR({
        group: result.group,
        version: result.version,
        resource: result.resource,
      });
      setSelectedKind(gvr, result.kind || result.resource);
      setSelectedResource(result.name, result.namespace || '');
      setActivePane('inspector');
      onClose();
    },
    [setActiveNamespace, setSelectedKind, setSelectedResource, setActivePane, onClose],
  );

  const handleConfirm = useCallback(
    (index?: number) => {
      const idx = index ?? selectedIndex;
      if (currentItems.length === 0) return;

      if (mode === 'search') {
        const result = searchResults[idx];
        if (!result) return;
        doSelectSearchResult(result);
        return;
      }

      const item = currentItems[idx];
      if (!item) return;

      if (!inArgMode) {
        const cmd = filteredCommands[idx];
        if (!cmd) return;
        if (cmd.action === 'selectKind') {
          doSelectKind(cmd);
        } else if (cmd.action === 'openPortForward') {
          doOpenPortForward();
        } else {
          setInput(cmd.aliases[0] + ' ');
          setSelectedIndex(0);
        }
        return;
      }

      const cmd = parsed.matchedCmd!;
      if (cmd.action === 'pickNamespace') {
        doSelectNamespace(item.id);
      } else if (cmd.action === 'pickContext') {
        doSelectContext(item.id);
      } else if (cmd.action === 'selectKind') {
        doSelectKind(cmd);
      }
    },
    [
      selectedIndex,
      currentItems,
      mode,
      searchResults,
      doSelectSearchResult,
      inArgMode,
      filteredCommands,
      parsed.matchedCmd,
      doSelectKind,
      doOpenPortForward,
      doSelectNamespace,
      doSelectContext,
    ],
  );

  const handleTab = useCallback(() => {
    if (mode !== 'command') return;
    if (currentItems.length === 0) return;
    const item = currentItems[selectedIndex];
    if (!item) return;

    if (!inArgMode) {
      const cmd = filteredCommands[selectedIndex];
      if (cmd) {
        setInput(cmd.aliases[0] + ' ');
        setSelectedIndex(0);
      }
      return;
    }

    const cmd = parsed.matchedCmd!;
    if (cmd.action === 'pickNamespace') {
      const val = item.id === '' ? '' : item.label;
      setInput(parsed.cmdText + ' ' + val);
    } else if (cmd.action === 'pickContext') {
      setInput(parsed.cmdText + ' ' + item.label);
    }
  }, [mode, currentItems, selectedIndex, inArgMode, filteredCommands, parsed.cmdText, parsed.matchedCmd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (mode === 'command' && inArgMode) {
          setInput(parsed.cmdText);
          setSelectedIndex(0);
        } else {
          onClose();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, currentItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        handleTab();
        return;
      }
    },
    [mode, inArgMode, parsed.cmdText, currentItems.length, handleConfirm, handleTab, onClose],
  );

  if (!open) return null;

  const prefix = mode === 'search' ? '/' : ':';
  const placeholder = mode === 'search'
    ? 'Global search: try "nginx" or "pod nginx"'
    : inArgMode
      ? parsed.matchedCmd!.action === 'pickNamespace'
        ? 'Filter namespaces...'
        : parsed.matchedCmd!.action === 'pickContext'
          ? 'Filter contexts...'
          : 'Press Enter to select'
      : 'Type a command...';

  const showEmpty = currentItems.length === 0 && !searchLoading;
  const searchCacheTone = searchCacheWarming
    ? 'warming'
    : searchCacheAgeMs <= 15000
      ? 'warm'
      : searchCacheAgeMs <= 90000
        ? 'refreshing'
        : 'stale';
  const searchCacheProgress = searchCacheWarming
    ? 35
    : searchCacheAgeMs <= 15000
      ? 100
      : searchCacheAgeMs <= 90000
        ? 70
        : 45;
  const searchCacheLabel = searchCacheWarming
    ? 'Search cache warming'
    : searchCacheAgeMs <= 15000
      ? 'Search cache warm'
      : searchCacheAgeMs <= 90000
        ? 'Search cache refreshing'
        : 'Search cache stale';

  return (
    <div className="cmd-palette-overlay" onMouseDown={onClose}>
      <div className="cmd-palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmd-palette-input-row">
          <span className="cmd-palette-prefix">{prefix}</span>
          <input
            ref={inputRef}
            className="cmd-palette-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {mode === 'search' && (searchLoading || showSearchCacheStatus) && (
          <div className={`search-cache-status ${searchCacheTone}`}>
            <div className="search-cache-status-text">{searchCacheLabel}</div>
            <div className="search-cache-status-track">
              <div className="search-cache-status-fill" style={{ width: `${searchCacheProgress}%` }} />
            </div>
          </div>
        )}
        <div className="cmd-palette-list" ref={listRef}>
          {searchLoading && mode === 'search' && (
            <div className="cmd-palette-empty">Searching resources...</div>
          )}
          {showEmpty && (
            <div className="cmd-palette-empty">
              {mode === 'search' && input.trim().length < 2 ? 'Type at least 2 characters' : 'No matches'}
            </div>
          )}
          {currentItems.map((item, i) => (
            <div
              key={item.id + i}
              className={`cmd-palette-item ${i === selectedIndex ? 'selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                handleConfirm(i);
              }}
            >
              <span className="cmd-palette-item-label">{item.label}</span>
              {item.description && (
                <span className="cmd-palette-item-desc">{item.description}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
