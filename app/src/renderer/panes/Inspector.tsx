import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import { useResource, useDeleteResource, useScaleResource, useRestartResource, useCordonNode, useUncordonNode, useDrainNode, useTriggerCronJob } from '../state/queries';
import { useToast } from '../hooks/useToast';
import { SummaryTab } from '../components/SummaryTab';
import { EventsTab } from '../components/EventsTab';
import { PodsTab } from '../components/PodsTab';
import { HelmReleaseInspector } from '../components/HelmReleaseInspector';

const YamlTab = lazy(async () => {
  const m = await import('../components/YamlTab');
  return { default: m.YamlTab };
});

const FormEditor = lazy(async () => {
  const m = await import('../components/FormEditor');
  return { default: m.FormEditor };
});


type TabName = 'summary' | 'edit' | 'yaml' | 'events' | 'pods';
const BASE_TABS: TabName[] = ['summary', 'edit', 'yaml', 'events'];

const SCALABLE_KINDS = new Set(['Deployment', 'StatefulSet', 'ReplicaSet']);
const RESTARTABLE_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job']);

export function Inspector() {
  const { selectedKindLabel, selectedResource, activeContext, activeNamespace, activePane } = useAppStore();

  if (selectedKindLabel === 'Helm Releases') {
    return <HelmReleaseInspector />;
  }

  return <ResourceInspector />;
}

function ResourceInspector() {
  const { activeContext, activeNamespace, selectedKind, selectedKindLabel, selectedResource, selectedResourceNamespace, activePane, setSelectedResource, readOnly } =
    useAppStore();
  const resourceNamespace = selectedResourceNamespace || activeNamespace;
  const resource = useResource(activeContext, resourceNamespace, selectedKind, selectedResource);
  const deleteMutation = useDeleteResource();
  const scaleMutation = useScaleResource();
  const restartMutation = useRestartResource();
  const cordonMutation = useCordonNode();
  const uncordonMutation = useUncordonNode();
  const drainMutation = useDrainNode();
  const triggerCronJobMutation = useTriggerCronJob();
  const addToast = useToast((s) => s.addToast);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmForceDelete, setConfirmForceDelete] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmDrain, setConfirmDrain] = useState(false);
  const [scaleInput, setScaleInput] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabName>('summary');
  const isFocused = activePane === 'inspector';

  // Reset tab when resource changes.
  useEffect(() => {
    setActiveTab('summary');
    setConfirmDelete(false);
    setConfirmForceDelete(false);
    setConfirmRestart(false);
    setConfirmDrain(false);
    setScaleInput(null);
  }, [selectedResource]);

  // Listen for menu-driven tab switches.
  useEffect(() => {
    const handleTabSwitch = (e: Event) => {
      const tab = (e as CustomEvent).detail as string;
      if (tab === 'logs' || tab === 'exec') {
        // Open in separate window instead of inline tab.
        openSessionWindowForCurrentResource(tab as 'logs' | 'exec');
      } else if (tab === 'summary' || tab === 'edit' || tab === 'yaml' || tab === 'events' || tab === 'pods') {
        setActiveTab(tab);
      }
    };
    const handleDeleteAction = () => {
      if (selectedResource && selectedKind && !readOnly) {
        setConfirmDelete(true);
      }
    };
    window.addEventListener('set-inspector-tab', handleTabSwitch);
    window.addEventListener('delete-resource', handleDeleteAction);
    return () => {
      window.removeEventListener('set-inspector-tab', handleTabSwitch);
      window.removeEventListener('delete-resource', handleDeleteAction);
    };
  }, [selectedResource, selectedKind, activeContext, resourceNamespace, readOnly]);

  function openSessionWindowForCurrentResource(kind: 'logs' | 'exec') {
    if (!selectedResource) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.openSessionWindow) return;
    api.openSessionWindow({
      kind,
      context: activeContext,
      namespace: resourceNamespace,
      pod: selectedResource,
      container: '',
    });
  }

  if (!selectedResource || !selectedKind) {
    return (
      <div className={`pane inspector ${isFocused ? 'focused' : ''}`}>
        <div className="pane-header">Inspector</div>
        <div className="inspector-empty">Select a resource to inspect</div>
      </div>
    );
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await deleteMutation.mutateAsync({
        context: activeContext,
        namespace: resourceNamespace,
        gvr: selectedKind,
        name: selectedResource,
      });
      setSelectedResource('');
      setConfirmDelete(false);
    } catch (err) {
      addToast('error', `Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleScale = async () => {
    if (scaleInput === null) return;
    const replicas = parseInt(scaleInput, 10);
    if (isNaN(replicas) || replicas < 0) return;
    try {
      await scaleMutation.mutateAsync({
        context: activeContext,
        namespace: resourceNamespace,
        gvr: selectedKind,
        name: selectedResource,
        replicas,
      });
      setScaleInput(null);
    } catch (err) {
      addToast('error', `Scale failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRestart = async () => {
    if (!confirmRestart) {
      setConfirmRestart(true);
      return;
    }
    try {
      await restartMutation.mutateAsync({
        context: activeContext,
        namespace: resourceNamespace,
        gvr: selectedKind,
        name: selectedResource,
      });
      setConfirmRestart(false);
    } catch (err) {
      addToast('error', `Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleForceDelete = async () => {
    if (!confirmForceDelete) {
      setConfirmForceDelete(true);
      return;
    }
    try {
      await deleteMutation.mutateAsync({
        context: activeContext,
        namespace: resourceNamespace,
        gvr: selectedKind,
        name: selectedResource,
        gracePeriod: 0,
      });
      setSelectedResource('');
      setConfirmForceDelete(false);
    } catch (err) {
      addToast('error', `Force delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCordon = async () => {
    try {
      await cordonMutation.mutateAsync({ context: activeContext, name: selectedResource });
    } catch (err) {
      addToast('error', `Cordon failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleUncordon = async () => {
    try {
      await uncordonMutation.mutateAsync({ context: activeContext, name: selectedResource });
    } catch (err) {
      addToast('error', `Uncordon failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDrain = async () => {
    if (!confirmDrain) {
      setConfirmDrain(true);
      return;
    }
    try {
      await drainMutation.mutateAsync({ context: activeContext, name: selectedResource, ignoreDaemonsets: true });
      setConfirmDrain(false);
    } catch (err) {
      addToast('error', `Drain failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleTriggerCronJob = async () => {
    try {
      const result = await triggerCronJobMutation.mutateAsync({
        context: activeContext,
        namespace: resourceNamespace,
        name: selectedResource,
      });
      addToast('success', `Job triggered: ${result.jobName}`);
    } catch (err) {
      addToast('error', `Trigger failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const res = resource.data?.resource;
  const kind = res?.kind || selectedKindLabel || '';

  const canScale = SCALABLE_KINDS.has(kind);
  const canRestart = RESTARTABLE_KINDS.has(kind);
  const canPodOps = kind === 'Pod';
  const canNodeOps = kind === 'Node';
  const canCronJobOps = kind === 'CronJob';
  const isUnschedulable = res?.summary.find(f => f.key === 'Unschedulable')?.value === 'true';

  const renderTabContent = () => {
    switch (activeTab) {
      case 'summary':
        return (
          <>
            {res && <SummaryTab resource={res} />}
            {resource.isLoading && <div className="loading">Loading...</div>}
          </>
        );
      case 'edit':
        return (
          <Suspense fallback={<div className="loading">Loading editor...</div>}>
            <FormEditor name={selectedResource} namespace={resourceNamespace} gvr={selectedKind} kind={kind} />
          </Suspense>
        );
      case 'yaml':
        return (
          <Suspense fallback={<div className="loading">Loading YAML...</div>}>
            <YamlTab name={selectedResource} namespace={resourceNamespace} gvr={selectedKind} />
          </Suspense>
        );
      case 'events':
        return (
          <EventsTab
            name={selectedResource}
            namespace={resourceNamespace}
            kind={kind}
            uid={res?.metadata?.uid}
          />
        );
      case 'pods':
        return <PodsTab kind={kind} name={selectedResource} namespace={resourceNamespace} />;
      default:
        return null;
    }
  };

  return (
    <div className={`pane inspector ${isFocused ? 'focused' : ''}`}>
      <div className="pane-header inspector-header">
        <div className="inspector-title">
          <span className="resource-kind">{kind}</span>
          <span
            className="resource-name selectable"
            onClick={(e) => {
              const range = document.createRange();
              range.selectNodeContents(e.currentTarget);
              window.getSelection()?.removeAllRanges();
              window.getSelection()?.addRange(range);
            }}
            title="Click to select"
          >{selectedResource}</span>
          {res?.metadata?.namespace && <span className="resource-ns">{res.metadata.namespace}</span>}
        </div>
        <div className="inspector-actions">
          <button onClick={() => setActiveTab('edit')} title="Edit data">
            Data
          </button>
          <button onClick={() => setActiveTab('yaml')} title="Edit YAML">
            YAML
          </button>
          {canScale && (
            scaleInput !== null ? (
              <>
                <input
                  type="number"
                  className="scale-input"
                  value={scaleInput}
                  onChange={(e) => setScaleInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleScale(); if (e.key === 'Escape') setScaleInput(null); }}
                  min={0}
                  autoFocus
                  placeholder="replicas"
                />
                <button onClick={handleScale} disabled={readOnly || scaleMutation.isPending}>
                  Apply
                </button>
                <button onClick={() => setScaleInput(null)}>Cancel</button>
              </>
            ) : (
              <button onClick={() => setScaleInput('1')} disabled={readOnly} title="Scale replicas">
                Scale
              </button>
            )
          )}
          {canRestart && (
            <button
              className={confirmRestart ? 'danger' : ''}
              onClick={handleRestart}
              disabled={readOnly || restartMutation.isPending}
              title="Rollout restart"
            >
              {confirmRestart ? 'Confirm Restart?' : 'Restart'}
            </button>
          )}
          {confirmRestart && (
            <button onClick={() => setConfirmRestart(false)}>Cancel</button>
          )}
          <button
            className={confirmDelete ? 'danger' : ''}
            onClick={handleDelete}
            title="Delete resource"
            disabled={readOnly || deleteMutation.isPending}
          >
            {confirmDelete ? 'Confirm Delete?' : 'Delete'}
          </button>
          {confirmDelete && (
            <button onClick={() => setConfirmDelete(false)}>Cancel</button>
          )}
          {canPodOps && (
            <>
              <button
                className={confirmForceDelete ? 'danger' : ''}
                onClick={handleForceDelete}
                title="Force delete pod (grace period 0)"
                disabled={readOnly || deleteMutation.isPending}
              >
                {confirmForceDelete ? 'Confirm Force Delete?' : 'Force Delete'}
              </button>
              {confirmForceDelete && (
                <button onClick={() => setConfirmForceDelete(false)}>Cancel</button>
              )}
            </>
          )}
          {canNodeOps && (
            <>
              <button
                onClick={handleCordon}
                disabled={readOnly || isUnschedulable || cordonMutation.isPending}
                title="Cordon node (mark unschedulable)"
              >
                Cordon
              </button>
              <button
                onClick={handleUncordon}
                disabled={readOnly || !isUnschedulable || uncordonMutation.isPending}
                title="Uncordon node (mark schedulable)"
              >
                Uncordon
              </button>
              <button
                className={confirmDrain ? 'danger' : ''}
                onClick={handleDrain}
                disabled={readOnly || drainMutation.isPending}
                title="Drain node (cordon + evict pods)"
              >
                {confirmDrain ? 'Confirm Drain?' : 'Drain'}
              </button>
              {confirmDrain && (
                <button onClick={() => setConfirmDrain(false)}>Cancel</button>
              )}
            </>
          )}
          {canCronJobOps && (
            <button
              onClick={handleTriggerCronJob}
              disabled={readOnly || triggerCronJobMutation.isPending}
              title="Create a Job from this CronJob now"
            >
              {triggerCronJobMutation.isPending ? 'Triggering…' : 'Run Now'}
            </button>
          )}
        </div>
      </div>

      <div className="tab-bar">
        {(WORKLOAD_KINDS.has(kind) ? [...BASE_TABS, 'pods' as TabName] : BASE_TABS).map((tab) => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'edit' ? 'Data' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {renderTabContent()}
      </div>
    </div>
  );
}
