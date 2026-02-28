import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { usePodInfo, useLogs } from '../state/queries';
import { useSessionEvent } from '../hooks/useSessionEvent';

export interface LogsTabSaveState {
  autoSave: boolean;
  doSave: () => Promise<boolean>;
}

interface LogsTabProps {
  name: string;
  namespace: string;
  context: string;
  initialContainer?: string;
  tabId?: string;
  onSaveStateChange?: (tabId: string, state: LogsTabSaveState | null) => void;
}

export function LogsTab({ name, namespace, context, initialContainer, tabId, onSaveStateChange }: LogsTabProps) {
  const [container, setContainer] = useState(initialContainer || '');
  const [tailLines, setTailLines] = useState(500);
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [autoSave, setAutoSave] = useState(false);
  const [savePath, setSavePath] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [sessionLocked, setSessionLocked] = useState(false);
  const wasLockedRef = useRef(false);
  const [logFilter, setLogFilter] = useState('');
  const [showLogFilter, setShowLogFilter] = useState(false);
  const [docHidden, setDocHidden] = useState(() => typeof document !== 'undefined' ? document.hidden : false);
  const logFilterRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const lastSavedLogsRef = useRef('');

  const podInfo = usePodInfo(context, namespace, name);
  const infos = podInfo.data?.containers || [];
  const podPhase = podInfo.data?.podPhase || '';
  const podTerminal = podPhase === 'Succeeded' || podPhase === 'Failed';
  const selectedContainerInfo = infos.find((c) => c.name === container);
  const selectedContainerTerminated = selectedContainerInfo?.state === 'terminated';
  const logsPollMs: number | false =
    previous ? false :
    sessionLocked ? false :
    !container ? false :
    (podTerminal || selectedContainerTerminated) ? false :
    docHidden ? 15000 :
    5000;

  // Only fetch logs when we have a container selected.
  const logs = useLogs(context, namespace, name, container, {
    tailLines,
    timestamps,
    previous,
    enabled: !sessionLocked && !!container,
    refetchIntervalMs: logsPollMs,
  });

  // Window-level keyboard shortcuts: Ctrl/Cmd+F (filter), Esc (close filter),
  // and Ctrl/Cmd+C (copy selection — handled here so it works even when the
  // <pre> is not the focused element, which is the common case after scrolling).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const primary = e.ctrlKey || e.metaKey;
      if (primary && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowLogFilter(true);
        setTimeout(() => logFilterRef.current?.focus(), 0);
        return;
      }
      if (primary && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
        const selected = window.getSelection()?.toString() ?? '';
        if (selected) {
          e.preventDefault();
          const api = (window as any).electronAPI;
          if (api?.clipboardWriteText) {
            api.clipboardWriteText(selected).catch(() => {});
          } else if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(selected).catch(() => {});
          }
        }
        return;
      }
      if (e.key === 'Escape' && showLogFilter) {
        setShowLogFilter(false);
        setLogFilter('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showLogFilter]);

  useEffect(() => {
    const onVisibility = () => setDocHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const filteredLogs = useMemo(() => {
    const raw = logs.data?.logs ?? '';
    if (!logFilter) return raw;
    return raw.split('\n').filter((line) => line.toLowerCase().includes(logFilter.toLowerCase())).join('\n');
  }, [logs.data?.logs, logFilter]);

  const filterMatchCount = useMemo(() => {
    if (!logFilter || !logs.data?.logs) return 0;
    return logs.data.logs.split('\n').filter((line) => line.toLowerCase().includes(logFilter.toLowerCase())).length;
  }, [logs.data?.logs, logFilter]);

  useSessionEvent((type) => {
    if (type === 'locked') {
      setSessionLocked(true);
    } else if (type === 'unlocked' || type === 'profile-changed') {
      setSessionLocked(false);
    }
  });

  // Trigger refetch when transitioning from locked → unlocked.
  useEffect(() => {
    if (wasLockedRef.current && !sessionLocked) {
      void logs.refetch();
      void podInfo.refetch();
    }
    wasLockedRef.current = sessionLocked;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionLocked]);

  // Auto-select first regular container.
  useEffect(() => {
    if (infos.length > 0 && !container) {
      const regular = infos.find((c) => !c.isInit);
      if (regular) setContainer(regular.name);
      else if (infos[0]) setContainer(infos[0].name);
    }
  }, [infos, container]);

  // Auto-scroll to bottom (disabled when filter is active so results stay visible).
  useEffect(() => {
    if (autoScroll && !logFilter && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs.data?.logs, autoScroll, logFilter]);

  // Persist log stream to local session logs directory when enabled.
  useEffect(() => {
    if (!autoSave || !container) return;
    const text = logs.data?.logs ?? '';
    if (!text) return;

    const prev = lastSavedLogsRef.current;
    let delta = '';
    if (!prev) {
      delta = text;
    } else if (text.startsWith(prev)) {
      delta = text.slice(prev.length);
    } else {
      delta = `\n\n--- log refresh ${new Date().toISOString()} ---\n${text}`;
    }
    if (!delta) return;

    const api = (window as any).electronAPI;
    if (!api?.sessionLogAppend) return;
    api
      .sessionLogAppend({ kind: 'logs', context, namespace, pod: name, container }, delta)
      .then((res: { path?: string }) => {
        if (res?.path) setSavePath(res.path);
      })
      .catch(() => {
        // Non-fatal: autosave should not break live logs.
      });
    lastSavedLogsRef.current = text;
  }, [autoSave, logs.data?.logs, container, context, namespace, name]);

  useEffect(() => {
    if (!autoSave) {
      lastSavedLogsRef.current = '';
      return;
    }
    const api = (window as any).electronAPI;
    if (!api?.sessionLogPath || !container) return;
    api
      .sessionLogPath({ kind: 'logs', context, namespace, pod: name, container })
      .then((p: string) => setSavePath(p))
      .catch(() => {});
  }, [autoSave, container, context, namespace, name]);

  const handleSaveAs = useCallback(async (): Promise<boolean> => {
    const api = (window as any).electronAPI;
    if (!api?.sessionLogSaveAs || !container) return false;
    const content = logs.data?.logs ?? '';
    const res = await api.sessionLogSaveAs(
      { kind: 'logs', context, namespace, pod: name, container },
      content,
    );
    if (!res?.canceled && res?.path) {
      setSaveStatus(`Saved: ${res.path}`);
      setTimeout(() => setSaveStatus(''), 3000);
      return true;
    }
    return false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, logs.data?.logs, context, namespace, name]);

  // Keep a ref to the latest handleSaveAs so onSaveStateChange gets a stable wrapper.
  const handleSaveAsRef = useRef(handleSaveAs);
  handleSaveAsRef.current = handleSaveAs;
  const stableDoSave = useRef((): Promise<boolean> => handleSaveAsRef.current()).current;

  // Register save state with SessionWindow so it can prompt on close.
  useEffect(() => {
    if (!tabId || !onSaveStateChange) return;
    onSaveStateChange(tabId, { autoSave, doSave: stableDoSave });
    return () => onSaveStateChange(tabId, null);
  }, [tabId, autoSave, onSaveStateChange, stableDoSave]);

  return (
    <div className="logs-tab" style={{ position: 'relative' }}>
      {sessionLocked && (
        <div className="session-locked-overlay">
          <div className="session-locked-message">
            <span className="session-locked-icon">🔒</span>
            <span>Store locked — unlock to resume</span>
          </div>
        </div>
      )}
      <div className="logs-toolbar">
        <label>
          Container:
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            {infos.map((c) => {
              const label = c.isInit ? `init:${c.name}` : c.name;
              const stateLabel = ` [${c.state || '?'}${c.ready ? '' : ', not ready'}]`;
              return (
                <option key={label} value={c.name}>
                  {label}{stateLabel}
                </option>
              );
            })}
          </select>
        </label>
        {podPhase && (
          <span className={`pod-phase-pill ${podPhase.toLowerCase()}`}>Pod: {podPhase}</span>
        )}
        <label>
          Tail:
          <select value={tailLines} onChange={(e) => setTailLines(Number(e.target.value))}>
            <option value={100}>100</option>
            <option value={500}>500</option>
            <option value={1000}>1000</option>
            <option value={5000}>5000</option>
            <option value={0}>All</option>
          </select>
        </label>
        <label className="logs-checkbox">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          Timestamps
        </label>
        <label className="logs-checkbox">
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
          Previous
        </label>
        <label className="logs-checkbox">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          Auto-scroll
        </label>
        <label className="logs-checkbox" title={savePath || 'Append logs to local session log file'}>
          <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} />
          Auto-save
        </label>
        <button className="logs-save-btn" onClick={handleSaveAs} disabled={!container}>
          Save...
        </button>
        {autoSave && savePath && <span className="logs-fetching" title={savePath} aria-live="polite">Saving: {savePath.split('/').slice(-2).join('/')}</span>}
        {saveStatus && <span className="logs-fetching" title={saveStatus} role="status" aria-live="polite">{saveStatus.split('/').slice(-2).join('/')}</span>}
        {logs.isFetching && <span className="logs-fetching" role="status" aria-live="polite">Refreshing...</span>}
        {!logs.isFetching && logsPollMs === false && container && (
          <span className="logs-fetching" title={previous ? 'Previous logs are static' : 'Polling paused for non-live logs'}>
            Polling paused
          </span>
        )}
        <button
          className="logs-save-btn"
          title="Find in logs (Ctrl+F)"
          aria-expanded={showLogFilter}
          aria-controls="logs-filter-input"
          onClick={() => { setShowLogFilter(true); setTimeout(() => logFilterRef.current?.focus(), 0); }}
        >
          Find
        </button>
      </div>
      {showLogFilter && (
        <div className="logs-filter-bar">
          <input
            ref={logFilterRef}
            id="logs-filter-input"
            className="logs-filter-input"
            type="text"
            placeholder="Filter lines…"
            value={logFilter}
            onChange={(e) => setLogFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setShowLogFilter(false); setLogFilter(''); }
            }}
          />
          {logFilter && (
            <span className="logs-filter-count">
              {filterMatchCount} {filterMatchCount === 1 ? 'match' : 'matches'}
            </span>
          )}
          <button className="logs-filter-close" aria-label="Close log filter" onClick={() => { setShowLogFilter(false); setLogFilter(''); }} title="Close (Esc)">×</button>
        </div>
      )}
      {infos.length > 1 && (
        <div className="container-status-bar">
          {infos.map((c) => (
            <span
              key={(c.isInit ? 'init:' : '') + c.name}
              className={`container-pill ${c.state} ${c.name === container ? 'active' : ''}`}
              onClick={() => setContainer(c.name)}
              title={`${c.isInit ? 'init:' : ''}${c.name}: ${c.state}${c.reason ? ' (' + c.reason + ')' : ''} | Restarts: ${c.restartCount}`}
            >
              <span className={`cpill-dot ${c.state} ${c.ready ? 'ready' : ''}`} />
              {c.isInit ? `init:${c.name}` : c.name}
              {c.restartCount > 0 && <span className="cpill-restarts">{c.restartCount}</span>}
            </span>
          ))}
        </div>
      )}
      <pre className="logs-content" ref={logRef} tabIndex={0} aria-label={`Logs output for pod ${name}${container ? `, container ${container}` : ''}`}>
        {!container && 'Select a container to view logs'}
        {container && logs.isLoading && 'Loading logs...'}
        {container && logs.error && `Error: ${String(logs.error)}`}
        {container && !logs.isLoading && !logs.error && filteredLogs}
        {container && logs.data && !logs.data.logs && !logFilter && '(no logs available)'}
        {container && logFilter && filterMatchCount === 0 && logs.data?.logs && '(no lines match filter)'}
      </pre>
    </div>
  );
}
