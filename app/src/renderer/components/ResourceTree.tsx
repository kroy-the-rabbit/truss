import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../state/store';
import { useResourceKinds, useResourceCounts } from '../state/queries';
import { GVR } from '../api/gen/truss/v1/resources_pb';
import { useTreeSections } from '../plugins/hooks';
import { createPluginAPI } from '../plugins/api';

function isRbacDeniedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const lower = msg.toLowerCase();
  return lower.includes('forbidden') || lower.includes('permission denied') || lower.includes('rbac');
}

export function ResourceTree() {
  const { activeContext, activeNamespace, setSelectedKind, selectedKindLabel, activePane, setActivePane } = useAppStore();
  const resourceKinds = useResourceKinds(activeContext);
  const treeSections = useTreeSections();
  const pluginApi = useMemo(() => createPluginAPI('@truss/builtin'), []);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['Workloads', 'Config', 'Networking']));
  const [collapsedCustomOwners, setCollapsedCustomOwners] = useState<Set<string>>(new Set());
  const [discoveryElapsedSec, setDiscoveryElapsedSec] = useState(0);
  const [focusedKey, setFocusedKey] = useState('');

  const isFocused = activePane === 'navigator';

  type KindRef = { kind: string; group: string; version: string; resource: string };

  const customKindsByOwner = useMemo(() => {
    const m = new Map<string, KindRef[]>();
    const customGroup = resourceKinds.data?.groups.find((g) => g.category === 'Custom');
    if (!customGroup) return m;
    for (const kind of customGroup.kinds) {
      const owner = kind.group || 'core';
      const existing = m.get(owner) ?? [];
      existing.push(kind);
      m.set(owner, existing);
    }
    return m;
  }, [resourceKinds.data]);

  // Sorted list of custom owners — must be stable for flatItems useMemo and JSX render.
  const sortedCustomOwners = useMemo(
    () => Array.from(customKindsByOwner.keys()).sort((a, b) => a.localeCompare(b)),
    [customKindsByOwner],
  );

  // Collect GVRs only from expanded groups to avoid flooding the API server.
  const allGvrs = useMemo(() => {
    if (!resourceKinds.data) return [];
    const gvrs: GVR[] = [];
    for (const group of resourceKinds.data.groups) {
      if (!expandedGroups.has(group.category)) continue;
      for (const kind of group.kinds) {
        if (group.category === 'Custom') {
          const owner = kind.group || 'core';
          if (collapsedCustomOwners.has(owner)) continue;
        }
        gvrs.push(new GVR({ group: kind.group, version: kind.version, resource: kind.resource }));
      }
    }
    return gvrs;
  }, [resourceKinds.data, expandedGroups, collapsedCustomOwners]);

  const counts = useResourceCounts(activeContext, activeNamespace, allGvrs);

  React.useEffect(() => {
    if (resourceKinds.data || (!resourceKinds.isLoading && !resourceKinds.isFetching)) {
      setDiscoveryElapsedSec(0);
      return;
    }
    const started = Date.now();
    const t = window.setInterval(() => {
      setDiscoveryElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => window.clearInterval(t);
  }, [resourceKinds.data, resourceKinds.isLoading, resourceKinds.isFetching]);

  // Build a map from "group/version/resource" to count.
  const countMap = useMemo(() => {
    const m = new Map<string, number>();
    if (counts.data?.counts) {
      for (const c of counts.data.counts) {
        if (c.gvr) {
          m.set(`${c.gvr.group}/${c.gvr.version}/${c.gvr.resource}`, c.count);
        }
      }
    }
    return m;
  }, [counts.data]);

  const toggleGroup = useCallback((category: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) { next.delete(category); } else { next.add(category); }
      return next;
    });
  }, []);

  const toggleCustomOwner = useCallback((owner: string) => {
    setCollapsedCustomOwners((prev) => {
      const next = new Set(prev);
      if (next.has(owner)) { next.delete(owner); } else { next.add(owner); }
      return next;
    });
  }, []);

  // Auto-expand the group containing the selected kind (e.g. from command palette).
  React.useEffect(() => {
    if (!selectedKindLabel || !resourceKinds.data) return;
    for (const group of resourceKinds.data.groups) {
      if (group.kinds.some((k) => k.kind === selectedKindLabel)) {
        setExpandedGroups((prev) => {
          if (prev.has(group.category)) return prev;
          const next = new Set(prev);
          next.add(group.category);
          return next;
        });
        break;
      }
    }
  }, [selectedKindLabel, resourceKinds.data]);

  const handleKindSelect = useCallback((kind: KindRef) => {
    const gvr = new GVR({ group: kind.group, version: kind.version, resource: kind.resource });
    setSelectedKind(gvr, kind.kind);
  }, [setSelectedKind]);

  // Auto-select Overview on first load when nothing is selected yet.
  React.useEffect(() => {
    if (resourceKinds.data && !selectedKindLabel) {
      setSelectedKind(null, 'Overview');
    }
  }, [resourceKinds.data, selectedKindLabel, setSelectedKind]);

  // -----------------------------------------------------------------------
  // Keyboard navigation
  // -----------------------------------------------------------------------

  // Flat ordered list of every currently-visible tree item, used for ↑↓ navigation.
  type FlatItem =
    | { key: string; type: 'overview' }
    | { key: string; type: 'group'; category: string }
    | { key: string; type: 'kind'; kind: KindRef }
    | { key: string; type: 'custom-owner'; owner: string }
    | { key: string; type: 'custom-kind'; kind: KindRef };

  const flatItems = useMemo((): FlatItem[] => {
    const items: FlatItem[] = [{ key: 'overview', type: 'overview' }];
    if (!resourceKinds.data) return items;
    for (const group of resourceKinds.data.groups) {
      items.push({ key: `group:${group.category}`, type: 'group', category: group.category });
      if (!expandedGroups.has(group.category)) continue;
      if (group.category !== 'Custom') {
        for (const k of group.kinds) {
          items.push({ key: `kind:${k.group}/${k.version}/${k.resource}`, type: 'kind', kind: k });
        }
      } else {
        for (const owner of sortedCustomOwners) {
          items.push({ key: `owner:${owner}`, type: 'custom-owner', owner });
          if (collapsedCustomOwners.has(owner)) continue;
          for (const k of customKindsByOwner.get(owner) ?? []) {
            items.push({ key: `ckind:${k.group}/${k.version}/${k.resource}`, type: 'custom-kind', kind: k });
          }
        }
      }
    }
    return items;
  }, [resourceKinds.data, expandedGroups, collapsedCustomOwners, sortedCustomOwners, customKindsByOwner]);

  // Refs so the event handler always reads fresh state without re-registering.
  const flatItemsRef = useRef(flatItems);
  useEffect(() => { flatItemsRef.current = flatItems; }, [flatItems]);
  const expandedGroupsRef = useRef(expandedGroups);
  useEffect(() => { expandedGroupsRef.current = expandedGroups; }, [expandedGroups]);
  const collapsedCustomOwnersRef = useRef(collapsedCustomOwners);
  useEffect(() => { collapsedCustomOwnersRef.current = collapsedCustomOwners; }, [collapsedCustomOwners]);

  // When the navigator pane gains focus, place the keyboard cursor on the selected item.
  useEffect(() => {
    if (!isFocused) { setFocusedKey(''); return; }
    const items = flatItemsRef.current;
    if (selectedKindLabel === 'Overview') { setFocusedKey('overview'); return; }
    if (selectedKindLabel) {
      const found = items.find(
        (i) => (i.type === 'kind' || i.type === 'custom-kind') && i.kind?.kind === selectedKindLabel,
      );
      setFocusedKey(found?.key ?? (items[0]?.key ?? ''));
      return;
    }
    setFocusedKey(items[0]?.key ?? '');
  }, [isFocused]); // eslint-disable-line react-hooks/exhaustive-deps — intentional: runs only on focus change

  // Handle tree-navigate events dispatched from App.tsx.
  useEffect(() => {
    if (!isFocused) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      const items = flatItemsRef.current;
      const exGroups = expandedGroupsRef.current;
      const colOwners = collapsedCustomOwnersRef.current;

      setFocusedKey((prevKey) => {
        const idx = items.findIndex((i) => i.key === prevKey);
        const ci = idx < 0 ? 0 : idx;

        if (detail === 'down') return items[Math.min(ci + 1, items.length - 1)]?.key ?? prevKey;
        if (detail === 'up') return items[Math.max(ci - 1, 0)]?.key ?? prevKey;

        if (detail === 'right') {
          const item = items[ci];
          if (item?.type === 'group' && !exGroups.has(item.category)) toggleGroup(item.category);
          else if (item?.type === 'custom-owner' && colOwners.has(item.owner)) toggleCustomOwner(item.owner);
          return prevKey;
        }

        if (detail === 'left') {
          const item = items[ci];
          if (item?.type === 'group' && exGroups.has(item.category)) { toggleGroup(item.category); return prevKey; }
          if (item?.type === 'custom-owner' && !colOwners.has(item.owner)) { toggleCustomOwner(item.owner); return prevKey; }
          // Move cursor up to the nearest parent header.
          for (let i = ci - 1; i >= 0; i--) {
            if (items[i].type === 'group' || items[i].type === 'custom-owner') return items[i].key;
          }
          return prevKey;
        }

        if (detail === 'select') {
          const item = items[ci];
          if (!item) return prevKey;
          if (item.type === 'overview') { setSelectedKind(null, 'Overview'); setActivePane('list'); }
          else if (item.type === 'group') toggleGroup(item.category);
          else if (item.type === 'kind') { handleKindSelect(item.kind); setActivePane('list'); }
          else if (item.type === 'custom-owner') toggleCustomOwner(item.owner);
          else if (item.type === 'custom-kind') { handleKindSelect(item.kind); setActivePane('list'); }
          return prevKey;
        }

        return prevKey;
      });
    };
    window.addEventListener('tree-navigate', handler);
    return () => window.removeEventListener('tree-navigate', handler);
  }, [isFocused, toggleGroup, toggleCustomOwner, handleKindSelect, setSelectedKind, setActivePane]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (resourceKinds.isError) {
    const denied = isRbacDeniedError(resourceKinds.error);
    return (
      <div className="resource-tree loading">
        <div>Failed to discover resources.</div>
        {denied && (
          <div style={{ marginTop: 8, opacity: 0.8 }}>
            Your current credentials may not be allowed to query Kubernetes discovery APIs.
          </div>
        )}
      </div>
    );
  }

  if (!resourceKinds.data) {
    return (
      <div className="resource-tree loading">
        <div>Discovering cluster resources...</div>
        <progress style={{ width: '100%', marginTop: 8 }} />
        {discoveryElapsedSec >= 3 && (
          <div style={{ marginTop: 8, opacity: 0.8 }}>
            This can take longer on large clusters or clusters with many CRDs.
          </div>
        )}
      </div>
    );
  }

  if (resourceKinds.data.groups.length === 0) {
    return (
      <div className="resource-tree loading">
        <div>No resource kinds available.</div>
        <div style={{ marginTop: 8, opacity: 0.8 }}>
          If this is unexpected, check cluster connectivity and RBAC permissions for discovery.
        </div>
      </div>
    );
  }

  const pluginSectionSelected = treeSections.some(() => false); // placeholder — sections manage their own highlight
  const isKindSelected = (kindLabel: string) => selectedKindLabel === kindLabel && !pluginSectionSelected;

  return (
    <div className="resource-tree">
      <div
        className={`kind-item overview-nav-item${selectedKindLabel === 'Overview' ? ' selected' : ''}${focusedKey === 'overview' ? ' tree-focused' : ''}`}
        onClick={() => setSelectedKind(null, 'Overview')}
      >
        ◈ Overview
      </div>
      {resourceKinds.data.groups.map((group) => (
        <div key={group.category} className="resource-group">
          <div
            className={`group-header${focusedKey === `group:${group.category}` ? ' tree-focused' : ''}`}
            onClick={() => toggleGroup(group.category)}
          >
            <span className="expand-icon">{expandedGroups.has(group.category) ? '\u25BC' : '\u25B6'}</span>
            <span className="group-name">{group.category}</span>
            <span className="group-count">{group.kinds.length}</span>
          </div>
          {expandedGroups.has(group.category) && group.category !== 'Custom' && (
            <div className="group-kinds">
              {group.kinds.map((kind) => {
                const countKey = `${kind.group}/${kind.version}/${kind.resource}`;
                const count = countMap.get(countKey);
                const itemKey = `kind:${countKey}`;
                return (
                  <div
                    key={`${kind.group}/${kind.kind}`}
                    className={`kind-item${isKindSelected(kind.kind) ? ' selected' : ''}${focusedKey === itemKey ? ' tree-focused' : ''}`}
                    onClick={() => handleKindSelect(kind)}
                  >
                    {kind.kind}
                    {count !== undefined && count > 0 && (
                      <span className="kind-count">{count}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {expandedGroups.has(group.category) && group.category === 'Custom' && (
            <div className="group-kinds">
              {sortedCustomOwners.map((owner) => {
                const kinds = customKindsByOwner.get(owner) ?? [];
                const collapsed = collapsedCustomOwners.has(owner);
                return (
                  <div key={owner} className="custom-owner-group">
                    <div
                      className={`custom-owner-header${focusedKey === `owner:${owner}` ? ' tree-focused' : ''}`}
                      onClick={() => toggleCustomOwner(owner)}
                    >
                      <span className="expand-icon">{collapsed ? '\u25B6' : '\u25BC'}</span>
                      <span className="custom-owner-name">{owner}</span>
                      <span className="group-count">{kinds.length}</span>
                    </div>
                    {!collapsed && (
                      <div className="custom-owner-kinds">
                        {kinds.map((kind) => {
                          const countKey = `${kind.group}/${kind.version}/${kind.resource}`;
                          const count = countMap.get(countKey);
                          const itemKey = `ckind:${countKey}`;
                          return (
                            <div
                              key={`${kind.group}/${kind.version}/${kind.kind}`}
                              className={`kind-item kind-item-nested${isKindSelected(kind.kind) ? ' selected' : ''}${focusedKey === itemKey ? ' tree-focused' : ''}`}
                              onClick={() => handleKindSelect(kind)}
                            >
                              {kind.kind}
                              {count !== undefined && count > 0 && (
                                <span className="kind-count">{count}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {treeSections.map((section) => (
        <React.Fragment key={section.id}>
          {section.render({ api: pluginApi })}
        </React.Fragment>
      ))}
    </div>
  );
}
