import React, { Suspense, lazy, useState, useEffect, useRef, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LogsTab } from './components/LogsTab';
import { ExecTab } from './components/ExecTab';
import type { LogsTabSaveState } from './components/LogsTab';
import type { ExecTabSaveState } from './components/ExecTab';
import { FileTransfer } from './components/FileTransfer';
import { PortForwardManager } from './components/PortForwardManager';
import { useSessionEvent } from './hooks/useSessionEvent';
import './styles.css';

const YamlDiffWindow = lazy(async () => {
  const m = await import('./components/YamlDiffWindow');
  return { default: m.YamlDiffWindow };
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10000,
      retry: 2,
    },
  },
});

interface SessionTab {
  id: string;
  context: string;
  namespace: string;
  pod: string;
  container: string;
}

function SessionContent() {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get('session') as 'logs' | 'exec' | 'files' | 'yaml-diff' | 'port-forward';

  const firstTab: SessionTab = {
    id: crypto.randomUUID(),
    context: params.get('context') || '',
    namespace: params.get('namespace') || '',
    pod: params.get('pod') || '',
    container: params.get('container') || '',
  };

  const initialPfType = (params.get('targetType') === 'service' ? 'service' : 'pod') as 'pod' | 'service';
  const initialPfName = params.get('targetName') || '';
  const initialPfLocalPort = Number(params.get('localPort') || '8080') || 8080;
  const initialPfTargetPort = params.get('targetPort') || '8080';

  const kindLabel = kind === 'logs'
    ? 'Logs'
    : kind === 'files'
      ? 'Files'
      : kind === 'port-forward'
        ? 'Port Forward'
      : kind === 'yaml-diff'
        ? 'YAML Diff'
        : 'Exec';

  const [tabs, setTabs] = useState<SessionTab[]>([firstTab]);
  const [activeId, setActiveId] = useState(firstTab.id);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saving, setSaving] = useState(false);

  type TabSaveState = LogsTabSaveState | ExecTabSaveState;
  const tabSaveRegistry = useRef<Map<string, TabSaveState>>(new Map());

  const handleTabSaveChange = useCallback((tabId: string, state: TabSaveState | null) => {
    if (state === null) {
      tabSaveRegistry.current.delete(tabId);
    } else {
      tabSaveRegistry.current.set(tabId, state);
    }
  }, []);

  useSessionEvent((type) => {
    if (type === 'locked') setSessionLocked(true);
    else setSessionLocked(false);
  });

  // Intercept window-close requests so logs/exec windows can offer to save.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.onBeforeClose) return;
    return api.onBeforeClose(() => {
      if (kind !== 'logs' && kind !== 'exec') {
        // Port-forward, files, yaml-diff — nothing to save.
        api.confirmWindowClose?.();
        return;
      }
      const states = Array.from(tabSaveRegistry.current.values());
      const allAutoSave = states.length > 0 && states.every((s) => s.autoSave);
      if (allAutoSave || states.length === 0) {
        // All tabs are auto-saving (incremental writes already in place) or nothing
        // has registered yet — close without prompting.
        api.confirmWindowClose?.();
      } else {
        setShowSaveModal(true);
      }
    });
  }, [kind]);

  // Keep the OS window title in sync with the active tab.
  useEffect(() => {
    if (kind === 'yaml-diff' || kind === 'port-forward') return;
    const tab = tabs.find((t) => t.id === activeId);
    if (tab) {
      const id = [tab.namespace, tab.pod].filter(Boolean).join('/');
      document.title = id ? `${id} — ${kindLabel}` : kindLabel;
    }
  }, [activeId, tabs, kind, kindLabel]);

  // Ctrl+Tab / Ctrl+Shift+Tab — cycle through tabs (logs and exec windows only).
  useEffect(() => {
    if (kind !== 'logs' && kind !== 'exec') return;
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'Tab') return;
      if (tabs.length <= 1) return;
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.id === activeId);
      if (e.shiftKey) {
        setActiveId(tabs[(idx - 1 + tabs.length) % tabs.length].id);
      } else {
        setActiveId(tabs[(idx + 1) % tabs.length].id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [kind, tabs, activeId]);

  // Listen for new tabs sent from the main process.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.onAddSessionTab) return;
    const cleanup = api.onAddSessionTab((tab: { context: string; namespace: string; pod: string; container: string }) => {
      setTabs((prev) => {
        // If a tab for this pod+container+context already exists, just activate it.
        const existing = prev.find(
          (t) => t.pod === tab.pod && t.container === tab.container && t.context === tab.context,
        );
        if (existing) {
          setActiveId(existing.id);
          return prev;
        }
        const newTab: SessionTab = { id: crypto.randomUUID(), ...tab };
        setActiveId(newTab.id);
        return [...prev, newTab];
      });
    });
    return cleanup;
  }, []);

  const closeTab = (id: string) => {
    setTabs((prev) => {
      if (prev.length === 1) return prev; // Never close the last tab.
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        setActiveId(next[Math.max(0, idx - 1)]?.id ?? next[0].id);
      }
      return next;
    });
  };

  // File transfer is a single-pane window (no tabs).
  if (kind === 'files') {
    return (
      <div className="session-window">
        <div style={{ position: 'relative', flex: 1 }}>
          <FileTransfer
            context={firstTab.context}
            namespace={firstTab.namespace}
            pod={firstTab.pod}
            initialContainer={firstTab.container || undefined}
          />
          {sessionLocked && (
            <div className="session-locked-overlay">
              <div className="session-locked-message">
                <span className="session-locked-icon">🔒</span>
                <span>Store locked — unlock to resume</span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (kind === 'yaml-diff') {
    return (
      <div className="session-window">
        <Suspense fallback={<div className="yaml-diff-loading">Loading diff...</div>}>
          <YamlDiffWindow />
        </Suspense>
      </div>
    );
  }

  if (kind === 'port-forward') {
    return (
      <div className="session-window">
        <PortForwardManager
          initialContext={firstTab.context}
          initialNamespace={firstTab.namespace}
          initialTargetType={initialPfType}
          initialTargetName={initialPfName || firstTab.pod}
          initialLocalPort={initialPfLocalPort}
          initialTargetPort={initialPfTargetPort}
        />
      </div>
    );
  }

  return (
    <div className="session-window">
      <div className="session-tab-bar">
        <span className="session-kind-label">{kind === 'logs' ? 'Logs' : 'Exec'}</span>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`session-tab ${tab.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(tab.id)}
            title={`${tab.namespace}/${tab.pod} [${tab.context}]`}
          >
            <span className="session-tab-label">
              <span className="session-tab-ns">{tab.namespace}/</span>{tab.pod}
              {tab.container ? <span className="session-tab-container">/{tab.container}</span> : null}
            </span>
            {tabs.length > 1 && (
              <button
                className="session-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                title="Close tab"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="session-tab-panels">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`session-tab-panel ${tab.id === activeId ? 'active' : ''}`}
          >
            {kind === 'logs' ? (
              <LogsTab
                context={tab.context}
                name={tab.pod}
                namespace={tab.namespace}
                initialContainer={tab.container || undefined}
                tabId={tab.id}
                onSaveStateChange={handleTabSaveChange}
              />
            ) : (
              <ExecTab
                context={tab.context}
                name={tab.pod}
                namespace={tab.namespace}
                initialContainer={tab.container || undefined}
                tabId={tab.id}
                onSaveStateChange={handleTabSaveChange}
              />
            )}
          </div>
        ))}
      </div>
      {showSaveModal && (
        <div className="save-on-close-overlay">
          <div className="save-on-close-dialog" role="dialog" aria-modal="true" aria-labelledby="soc-title">
            <p id="soc-title" className="save-on-close-title">
              Save session {kind === 'exec' ? 'terminal output' : 'logs'} before closing?
            </p>
            <div className="save-on-close-buttons">
              <button
                className="soc-btn soc-btn-save"
                disabled={saving}
                onClick={async () => {
                  const activeState = tabSaveRegistry.current.get(activeId);
                  if (!activeState) {
                    setShowSaveModal(false);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (window as any).electronAPI?.confirmWindowClose?.();
                    return;
                  }
                  setSaving(true);
                  try {
                    const saved = await activeState.doSave();
                    if (saved) {
                      setShowSaveModal(false);
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      (window as any).electronAPI?.confirmWindowClose?.();
                    }
                    // If saved===false the file dialog was canceled — keep modal open.
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? 'Saving…' : 'Save…'}
              </button>
              <button
                className="soc-btn soc-btn-nosave"
                disabled={saving}
                onClick={() => {
                  setShowSaveModal(false);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (window as any).electronAPI?.confirmWindowClose?.();
                }}
              >
                Close Without Saving
              </button>
              <button
                className="soc-btn soc-btn-cancel"
                disabled={saving}
                onClick={() => setShowSaveModal(false)}
              >
                Cancel
              </button>
            </div>
            {tabs.length > 1 && (
              <p className="save-on-close-note">
                Only the active tab will be saved.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SessionWindow() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionContent />
    </QueryClientProvider>
  );
}
