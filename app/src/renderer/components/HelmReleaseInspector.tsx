import React, { Suspense, lazy, useState, useEffect } from 'react';
import { useAppStore } from '../state/store';
import {
  useHelmRelease,
  useHelmReleaseValues,
  useHelmReleaseHistory,
  useUninstallRelease,
  useRollbackRelease,
  useUpgradeRelease,
} from '../state/queries';
import { useToast } from '../hooks/useToast';

const MonacoEditor = lazy(async () => {
  const m = await import('@monaco-editor/react');
  return { default: m.default };
});

type HelmTab = 'summary' | 'values' | 'history';

export function HelmReleaseInspector() {
  const { activeContext, selectedResource, selectedResourceNamespace, activeNamespace, activePane, readOnly, setSelectedResource } = useAppStore();
  const isFocused = activePane === 'inspector';
  const [activeTab, setActiveTab] = useState<HelmTab>('summary');
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [expandedRevision, setExpandedRevision] = useState<number | null>(null);
  const [confirmRollbackRevision, setConfirmRollbackRevision] = useState<number | null>(null);
  const [editingValues, setEditingValues] = useState(false);
  const [editedValues, setEditedValues] = useState('');

  // Listen for tab-switch events dispatched from context menus.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail as string;
      if (tab === 'summary' || tab === 'values' || tab === 'history') {
        setActiveTab(tab);
      }
    };
    window.addEventListener('set-inspector-tab', handler);
    return () => window.removeEventListener('set-inspector-tab', handler);
  }, []);

  const releaseNamespace = selectedResourceNamespace || activeNamespace;
  const release = useHelmRelease(activeContext, releaseNamespace, selectedResource);
  const values = useHelmReleaseValues(activeContext, releaseNamespace, selectedResource);
  const history = useHelmReleaseHistory(activeContext, releaseNamespace, selectedResource);
  const uninstallMutation = useUninstallRelease();
  const rollbackMutation = useRollbackRelease();
  const upgradeMutation = useUpgradeRelease();
  const addToast = useToast((s) => s.addToast);

  if (!selectedResource) {
    return (
      <div className={`pane inspector ${isFocused ? 'focused' : ''}`}>
        <div className="pane-header">Inspector</div>
        <div className="inspector-empty">Select a Helm release to inspect</div>
      </div>
    );
  }

  const rel = release.data?.release;

  const handleUninstall = async () => {
    if (!confirmUninstall) {
      setConfirmUninstall(true);
      return;
    }
    try {
      await uninstallMutation.mutateAsync({
        context: activeContext,
        namespace: releaseNamespace,
        name: selectedResource,
      });
      setSelectedResource('');
      setConfirmUninstall(false);
    } catch (err) {
      addToast('error', `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRollback = async (revision: number) => {
    if (confirmRollbackRevision !== revision) {
      setConfirmRollbackRevision(revision);
      return;
    }
    try {
      await rollbackMutation.mutateAsync({
        context: activeContext,
        namespace: releaseNamespace,
        name: selectedResource,
        revision,
      });
      setConfirmRollbackRevision(null);
      setExpandedRevision(null);
    } catch (err) {
      addToast('error', `Rollback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const statusClass = (status: string) => {
    const s = status.toLowerCase();
    if (s === 'deployed') return 'helm-status-deployed';
    if (s === 'failed') return 'helm-status-failed';
    if (s === 'uninstalled') return 'helm-status-failed';
    return 'helm-status-pending';
  };

  const renderSummary = () => {
    if (release.isLoading) return <div className="loading">Loading...</div>;
    if (!rel) return null;
    return (
      <div className="summary-tab">
        <div className="summary-section">
          <h3>Release Info</h3>
          <div className="summary-fields">
            <div className="summary-field">
              <span className="field-key">Name</span>
              <span className="field-value">{rel.name}</span>
            </div>
            <div className="summary-field">
              <span className="field-key">Namespace</span>
              <span className="field-value">{rel.namespace}</span>
            </div>
            <div className="summary-field">
              <span className="field-key">Status</span>
              <span className={`field-value helm-status-badge ${statusClass(rel.status)}`}>{rel.status}</span>
            </div>
            <div className="summary-field">
              <span className="field-key">Revision</span>
              <span className="field-value">{rel.revision}</span>
            </div>
            <div className="summary-field">
              <span className="field-key">Chart</span>
              <span className="field-value">{rel.chart}-{rel.chartVersion}</span>
            </div>
            <div className="summary-field">
              <span className="field-key">App Version</span>
              <span className="field-value">{rel.appVersion || '-'}</span>
            </div>
            <div className="summary-field">
              <span className="field-key">Last Deployed</span>
              <span className="field-value">{rel.updated ? new Date(rel.updated).toLocaleString() : '-'}</span>
            </div>
          </div>
        </div>
        {rel.notes && (
          <div className="summary-section">
            <h3>Notes</h3>
            <pre className="helm-notes">{rel.notes}</pre>
          </div>
        )}
      </div>
    );
  };

  const handleEditValues = () => {
    setEditedValues(values.data?.valuesYaml || '# No values\n');
    setEditingValues(true);
  };

  const handleCancelEditValues = () => {
    setEditingValues(false);
    setEditedValues('');
  };

  const handleUpgrade = async () => {
    try {
      await upgradeMutation.mutateAsync({
        context: activeContext,
        namespace: releaseNamespace,
        name: selectedResource,
        valuesYaml: editedValues,
      });
      setEditingValues(false);
      setEditedValues('');
    } catch (err) {
      addToast('error', `Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const renderValues = () => {
    if (values.isLoading) return <div className="loading">Loading...</div>;
    if (editingValues) {
      return (
        <div className="helm-values-tab helm-values-edit">
          <div className="helm-values-edit-actions">
            <button
              onClick={handleUpgrade}
              disabled={readOnly || upgradeMutation.isPending}
              className="apply-btn"
            >
              {upgradeMutation.isPending ? 'Upgrading...' : 'Upgrade'}
            </button>
            <button onClick={handleCancelEditValues}>Cancel</button>
          </div>
          <div className="helm-values-editor">
            <Suspense fallback={<div className="loading">Loading editor...</div>}>
              <MonacoEditor
                height="100%"
                language="yaml"
                theme="vs-dark"
                value={editedValues}
                onChange={(v) => { if (v !== undefined) setEditedValues(v); }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  automaticLayout: true,
                }}
              />
            </Suspense>
          </div>
        </div>
      );
    }
    return (
      <div className="helm-values-tab">
        <div className="helm-values-toolbar">
          <button onClick={handleEditValues} disabled={readOnly} title="Edit values and upgrade">
            Edit Values
          </button>
        </div>
        <pre className="helm-values-content">{values.data?.valuesYaml || '# No values'}</pre>
      </div>
    );
  };

  const renderHistory = () => {
    if (history.isLoading) return <div className="loading">Loading...</div>;
    const revisions = history.data?.revisions || [];
    return (
      <div className="helm-history-tab">
        <div className="events-table helm-history-table">
          <div className="events-header helm-history-header">
            <span className="helm-hist-rev">Rev</span>
            <span className="helm-hist-status">Status</span>
            <span className="helm-hist-chart">Chart</span>
            <span className="helm-hist-desc">Description</span>
            <span className="helm-hist-updated">Age</span>
          </div>
          {revisions.map((rev) => (
            <React.Fragment key={rev.revision}>
              <div
                className={`events-row clickable helm-history-row ${expandedRevision === rev.revision ? 'expanded' : ''}${rev.status.toLowerCase() === 'failed' ? ' warning' : ''}`}
                onClick={() => {
                  setExpandedRevision(expandedRevision === rev.revision ? null : rev.revision);
                  setConfirmRollbackRevision(null);
                }}
              >
                <span className="helm-hist-rev">{rev.revision}</span>
                <span className={`helm-hist-status ${statusClass(rev.status)}`}>{rev.status}</span>
                <span className="helm-hist-chart" title={rev.chart}>{rev.chart}</span>
                <span className="helm-hist-desc" title={rev.description}>{rev.description || '-'}</span>
                <span className="helm-hist-updated" title={rev.updated}>{rev.updated ? formatAge(rev.updated) : '-'}</span>
              </div>
              {expandedRevision === rev.revision && (
                <div className="event-detail helm-history-detail">
                  <div className="event-detail-row"><span className="event-detail-label">Revision</span><span className="event-detail-value">{rev.revision}</span></div>
                  <div className="event-detail-row"><span className="event-detail-label">Status</span><span className={`event-detail-value ${statusClass(rev.status)}`}>{rev.status}</span></div>
                  <div className="event-detail-row"><span className="event-detail-label">Chart</span><span className="event-detail-value">{rev.chart || '-'}</span></div>
                  <div className="event-detail-row"><span className="event-detail-label">Description</span><span className="event-detail-value event-detail-message">{rev.description || '-'}</span></div>
                  <div className="event-detail-row"><span className="event-detail-label">Updated</span><span className="event-detail-value">{rev.updated ? new Date(rev.updated).toLocaleString() : '-'}</span></div>
                  {rev.revision !== rel?.revision && (
                    <div className="event-detail-row">
                      <span className="event-detail-label">Action</span>
                      <span className="event-detail-value">
                        <button
                          className={`helm-rollback-btn ${confirmRollbackRevision === rev.revision ? 'danger' : ''}`}
                          disabled={readOnly || rollbackMutation.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRollback(rev.revision);
                          }}
                        >
                          {confirmRollbackRevision === rev.revision ? `Confirm rollback to ${rev.revision}` : `Rollback to ${rev.revision}`}
                        </button>
                      </span>
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          ))}
          {revisions.length === 0 && <div className="events-empty">No release history found</div>}
        </div>
      </div>
    );
  };

  return (
    <div className={`pane inspector ${isFocused ? 'focused' : ''}`}>
      <div className="pane-header">
        <div className="inspector-title">
          <span className="resource-kind">Helm</span>
          <span className="resource-name">{selectedResource}</span>
          {releaseNamespace && <span className="resource-ns">{releaseNamespace}</span>}
        </div>
        <div className="inspector-actions">
          <button
            className={confirmUninstall ? 'danger' : ''}
            onClick={handleUninstall}
            disabled={readOnly || uninstallMutation.isPending}
          >
            {confirmUninstall ? 'Confirm Uninstall?' : 'Uninstall'}
          </button>
          {confirmUninstall && (
            <button onClick={() => setConfirmUninstall(false)}>Cancel</button>
          )}
        </div>
      </div>
      <div className="tab-bar">
        {(['summary', 'values', 'history'] as HelmTab[]).map((tab) => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      <div className="tab-content">
        {activeTab === 'summary' && renderSummary()}
        {activeTab === 'values' && renderValues()}
        {activeTab === 'history' && renderHistory()}
      </div>
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
