import React, { useEffect, useMemo, useState } from 'react';
import { useSessionEvent } from '../hooks/useSessionEvent';

interface PortForwardRecord {
  id: string;
  context: string;
  namespace: string;
  targetType: 'pod' | 'service';
  targetName: string;
  localPort: number;
  targetPort: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  startedAt: string;
  stoppedAt?: string;
  pid?: number;
  message?: string;
  output: string;
}

interface Props {
  initialContext: string;
  initialNamespace: string;
  initialTargetType: 'pod' | 'service';
  initialTargetName: string;
  initialLocalPort: number;
  initialTargetPort: number;
}

export function PortForwardManager({
  initialContext,
  initialNamespace,
  initialTargetType,
  initialTargetName,
  initialLocalPort,
  initialTargetPort,
}: Props) {
  useEffect(() => {
    document.title = 'Port Forward Manager';
  }, []);

  const [context, setContext] = useState(initialContext);
  const [namespace, setNamespace] = useState(initialNamespace);
  const [targetType, setTargetType] = useState<'pod' | 'service'>(initialTargetType);
  const [targetName, setTargetName] = useState(initialTargetName);
  const [localPort, setLocalPort] = useState(String(initialLocalPort || 8080));
  const [targetPort, setTargetPort] = useState(String(initialTargetPort || 8080));
  const [rows, setRows] = useState<PortForwardRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [sessionLocked, setSessionLocked] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).electronAPI;

  const refresh = async () => {
    if (!api?.portForwardList) return;
    const data = await api.portForwardList();
    setRows(Array.isArray(data) ? data : []);
    setSelectedId((prev: string) => prev || data?.[0]?.id || '');
  };

  useSessionEvent((type) => {
    if (type === 'locked') {
      setSessionLocked(true);
    } else if (type === 'unlocked' || type === 'profile-changed') {
      setSessionLocked(false);
    }
  });

  useEffect(() => {
    void refresh();
    if (sessionLocked) return; // don't start polling when locked
    const t = window.setInterval(() => {
      void refresh();
    }, 1200);
    return () => window.clearInterval(t);
  }, [sessionLocked]);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) || null, [rows, selectedId]);

  // Keyboard shortcuts for the port-forward manager window.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      const inButton = target instanceof HTMLButtonElement;

      // Ctrl/Cmd+Enter → Start Forward (works from anywhere including inputs).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        void start();
        return;
      }
      // Delete → Stop selected running/starting session (outside inputs).
      if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !inInput) {
        if (selected && (selected.status === 'running' || selected.status === 'starting')) {
          e.preventDefault();
          void stop(selected.id);
        }
        return;
      }
      // Enter → Open URL for selected running session (outside inputs and buttons).
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !inInput && !inButton) {
        if (selected?.status === 'running') {
          e.preventDefault();
          void openUrl(selected.id);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  const start = async () => {
    setError('');
    if (sessionLocked) {
      setError('Store is locked. Unlock to start a port-forward.');
      return;
    }
    if (!api?.portForwardStart) return;
    const lp = Number(localPort);
    const tp = Number(targetPort);
    if (!namespace.trim() || !targetName.trim() || !Number.isFinite(lp) || !Number.isFinite(tp)) {
      setError('Namespace, target, and valid ports are required.');
      return;
    }
    setBusy(true);
    try {
      const rec = await api.portForwardStart({
        context: context.trim(),
        namespace: namespace.trim(),
        targetType,
        targetName: targetName.trim(),
        localPort: lp,
        targetPort: tp,
      });
      if (rec?.id) setSelectedId(rec.id);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    if (!api?.portForwardStop) return;
    await api.portForwardStop(id);
    await refresh();
  };

  const openUrl = async (id: string) => {
    if (sessionLocked) {
      setError('Store is locked. Unlock to open port-forward URLs.');
      return;
    }
    if (!api?.portForwardOpenUrl) return;
    await api.portForwardOpenUrl(id);
  };

  return (
    <div className="pf-window" style={{ position: 'relative' }}>
      {sessionLocked && (
        <div className="session-locked-overlay">
          <div className="session-locked-message">
            <span className="session-locked-icon">🔒</span>
            <span>Store locked — unlock to resume</span>
          </div>
        </div>
      )}
      <div className="pf-header">
        <h2>Port Forward Manager</h2>
        <p>Manage local tunnels for pods/services and jump straight into debugging dashboards.</p>
      </div>

      <div className="pf-form">
        <label>
          Context
          <input value={context} onChange={(e) => setContext(e.target.value)} placeholder="(active context if empty)" />
        </label>
        <label>
          Namespace
          <input value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="default" />
        </label>
        <label>
          Target Type
          <select value={targetType} onChange={(e) => setTargetType(e.target.value as 'pod' | 'service')}>
            <option value="pod">Pod</option>
            <option value="service">Service</option>
          </select>
        </label>
        <label>
          Target Name
          <input value={targetName} onChange={(e) => setTargetName(e.target.value)} placeholder="resource name" />
        </label>
        <label>
          Local Port
          <input value={localPort} onChange={(e) => setLocalPort(e.target.value)} />
        </label>
        <label>
          Target Port
          <input value={targetPort} onChange={(e) => setTargetPort(e.target.value)} />
        </label>
        <button className="pf-start-btn" onClick={() => void start()} disabled={busy || sessionLocked}>
          Start Forward
        </button>
      </div>
      {error && <div className="pf-error">{error}</div>}

      <div className="pf-main">
        <div className="pf-list">
          {rows.length === 0 && <div className="pf-empty">No active or recent forwards.</div>}
          {rows.map((r) => (
            <button
              key={r.id}
              className={`pf-row ${selectedId === r.id ? 'active' : ''}`}
              onClick={() => setSelectedId(r.id)}
            >
              <span className={`pf-state ${r.status}`}>{r.status}</span>
              <span className="pf-target">{r.namespace}/{r.targetType === 'service' ? 'svc' : 'pod'}/{r.targetName}</span>
              <span className="pf-ports">{r.localPort} {'->'} {r.targetPort}</span>
            </button>
          ))}
        </div>
        <div className="pf-detail">
          {!selected ? (
            <div className="pf-empty">Select a forward to inspect output.</div>
          ) : (
            <>
              <div className="pf-detail-actions">
                <span>{selected.namespace}/{selected.targetType}/{selected.targetName}</span>
                <div>
                  <button onClick={() => void openUrl(selected.id)} disabled={selected.status !== 'running'}>Open URL</button>
                  <button onClick={() => void stop(selected.id)} disabled={selected.status !== 'running' && selected.status !== 'starting'}>Stop</button>
                </div>
              </div>
              {selected.message && (
                <div className="pf-error" style={{ paddingTop: 8, paddingBottom: 0 }}>
                  {selected.message}
                </div>
              )}
              <pre className="pf-output">{selected.output || '(no output yet)'}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
