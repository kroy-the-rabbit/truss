import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { usePodInfo } from '../state/queries';
import { useSessionEvent } from '../hooks/useSessionEvent';

export interface ExecTabSaveState {
  autoSave: boolean;
  doSave: () => Promise<boolean>;
}

interface ExecTabProps {
  name: string;
  namespace: string;
  context: string;
  initialContainer?: string;
  tabId?: string;
  onSaveStateChange?: (tabId: string, state: ExecTabSaveState | null) => void;
}

export function ExecTab({ name, namespace, context, initialContainer, tabId, onSaveStateChange }: ExecTabProps) {
  const [container, setContainer] = useState(initialContainer || '');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [autoSave, setAutoSave] = useState(false);
  const [savePath, setSavePath] = useState('');
  const [sessionLocked, setSessionLocked] = useState(false);
  const wasLockedRef = useRef(false);
  const termRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const termContextMenuCleanupRef = useRef<(() => void) | null>(null);
  const manualCloseRef = useRef(false);
  const decoderRef = useRef(new TextDecoder());
  const captureRef = useRef('');
  const autoConnectedRef = useRef(false);
  // Snapshot of terminal selection taken when the context menu opens (before focus shifts away).
  const contextMenuSelectionRef = useRef('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || '');
  const primaryKeyLabel = isMac ? 'Cmd' : 'Ctrl';

  const podInfo = usePodInfo(context, namespace, name);
  const allInfos = podInfo.data?.containers || [];
  const runningContainers = allInfos.filter(
    (c) => c.isInit !== true && (c.state || '').toLowerCase() === 'running',
  );
  const podPhase = podInfo.data?.podPhase || '';

  // Keep container pinned to a running, non-init container only.
  // Guard on podInfo.data so we don't clear the initial container selection
  // while the pod info is still loading (runningContainers would be [] during load).
  useEffect(() => {
    if (!podInfo.data) return;
    if (runningContainers.length === 0) {
      if (container) setContainer('');
      return;
    }
    const currentIsRunning = runningContainers.some((c) => c.name === container);
    if (!currentIsRunning) {
      setContainer(runningContainers[0].name);
    }
  }, [podInfo.data, runningContainers, container]);

  // When the user switches containers, tear down the current session so auto-connect fires fresh.
  const prevContainerRef = useRef('');
  useEffect(() => {
    if (!container) return;
    if (prevContainerRef.current === container) return;
    if (prevContainerRef.current !== '') {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      if (termContextMenuCleanupRef.current) {
        termContextMenuCleanupRef.current();
        termContextMenuCleanupRef.current = null;
      }
      if (terminalRef.current) { terminalRef.current.dispose(); terminalRef.current = null; }
      setConnected(false);
      autoConnectedRef.current = false;
    }
    prevContainerRef.current = container;
  }, [container]);

  const connect = useCallback(async () => {
    if (!container || !namespace || !name) return;

    setError('');
    setConnected(false);

    if (wsRef.current) {
      manualCloseRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }
    if (termContextMenuCleanupRef.current) {
      termContextMenuCleanupRef.current();
      termContextMenuCleanupRef.current = null;
    }
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    try {
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        theme: {
          background: '#1e1e2e',
          foreground: '#cdd6f4',
          cursor: '#f5e0dc',
          selectionBackground: 'rgba(137, 180, 250, 0.3)',
          black: '#45475a',
          red: '#f38ba8',
          green: '#a6e3a1',
          yellow: '#f9e2af',
          blue: '#89b4fa',
          magenta: '#f5c2e7',
          cyan: '#94e2d5',
          white: '#bac2de',
          brightBlack: '#585b70',
          brightRed: '#f38ba8',
          brightGreen: '#a6e3a1',
          brightYellow: '#f9e2af',
          brightBlue: '#89b4fa',
          brightMagenta: '#f5c2e7',
          brightCyan: '#94e2d5',
          brightWhite: '#a6adc8',
        },
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      if (termRef.current) {
        termRef.current.innerHTML = '';
        terminal.open(termRef.current);
        fitAddon.fit();
      }

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      const copySelection = async () => {
        const selected = terminal.getSelection();
        if (!selected) return;
        const api = (window as any).electronAPI;
        if (api?.clipboardWriteText) {
          await api.clipboardWriteText(selected);
          return;
        }
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(selected);
        }
      };

      const pasteClipboard = async () => {
        const api = (window as any).electronAPI;
        let text = '';
        if (api?.clipboardReadText) {
          text = String((await api.clipboardReadText()) ?? '');
        } else if (navigator.clipboard?.readText) {
          text = await navigator.clipboard.readText();
        }
        if (text) terminal.paste(text);
      };

      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const key = event.key.toLowerCase();
        const primary = event.ctrlKey || event.metaKey;
        if (!primary || event.altKey) return true;
        if (!event.shiftKey && key === 'c') {
          // Keep Ctrl/Cmd+C behavior for in-terminal SIGINT.
          return true;
        }
        if (event.shiftKey && key === 'c') {
          event.preventDefault();
          void copySelection();
          return false;
        }
        if (event.shiftKey && key === 'v') {
          event.preventDefault();
          void pasteClipboard();
          return false;
        }
        return true;
      });

      if (termRef.current) {
        const onContextMenu = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          // Snapshot the selection now, before focus shifts to the React menu div.
          contextMenuSelectionRef.current = terminal.getSelection();
          setMenuPos({ x: e.clientX, y: e.clientY });
          setMenuOpen(true);
        };
        termRef.current.addEventListener('contextmenu', onContextMenu);
        termContextMenuCleanupRef.current = () => {
          termRef.current?.removeEventListener('contextmenu', onContextMenu);
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = await (window as any).electronAPI.getDaemonConfig();
      if (!config) {
        setError('Daemon not connected');
        return;
      }

      const params = new URLSearchParams({
        context,
        namespace,
        pod: name,
        container,
      });

      const ws = new WebSocket(
        `ws://127.0.0.1:${config.port}/ws/exec?${params}`,
        ['truss-exec-v1', `truss-token-${config.token}`],
      );
      wsRef.current = ws;
      manualCloseRef.current = false;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        setConnected(true);
        terminal.focus();
        fitAddon.fit(); // Re-fit now that the connection is live and layout is settled
        ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      };

      ws.onmessage = (event) => {
        let textChunk = '';
        if (event.data instanceof ArrayBuffer) {
          const chunk = new Uint8Array(event.data);
          terminal.write(chunk);
          textChunk = decoderRef.current.decode(chunk, { stream: true });
        } else {
          terminal.write(event.data);
          textChunk = String(event.data);
        }
        if (autoSave && textChunk) {
          const api = (window as any).electronAPI;
          if (api?.sessionLogAppend) {
            api
              .sessionLogAppend({ kind: 'exec', context, namespace, pod: name, container }, textChunk)
              .then((res: { path?: string }) => {
                if (res?.path) setSavePath(res.path);
              })
              .catch(() => {});
          }
        }
        if (textChunk) {
          captureRef.current += textChunk;
          if (captureRef.current.length > 2_000_000) {
            captureRef.current = captureRef.current.slice(-2_000_000);
          }
        }
      };

      ws.onclose = (event) => {
        setConnected(false);
        if (manualCloseRef.current) {
          terminal.write('\r\n[Session closed]\r\n');
          manualCloseRef.current = false;
          return;
        }
        const detail = event.reason ? `${event.code}: ${event.reason}` : `${event.code}`;
        setError(`WebSocket disconnected (${detail})`);
        terminal.write(`\r\n[WebSocket disconnected: ${detail}]\r\n`);
      };

      ws.onerror = () => {
        setError('WebSocket connection failed');
        setConnected(false);
      };

      terminal.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        }
      });
      if (termRef.current) {
        resizeObserver.observe(termRef.current);
      }
    } catch (err) {
      setError(`Failed to initialize terminal: ${err}`);
    }
  }, [context, namespace, name, container]);

  const copyFromTerminal = useCallback(async () => {
    // Prefer the snapshot taken at context-menu open time (the live selection may have
    // been cleared by the time the user clicks "Copy" in the React menu).
    const selected = contextMenuSelectionRef.current || terminalRef.current?.getSelection() || '';
    contextMenuSelectionRef.current = ''; // Consume the snapshot.
    if (!selected) return;
    const api = (window as any).electronAPI;
    if (api?.clipboardWriteText) {
      await api.clipboardWriteText(selected);
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(selected);
    }
  }, []);

  const pasteIntoTerminal = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const api = (window as any).electronAPI;
    let text = '';
    if (api?.clipboardReadText) {
      text = String((await api.clipboardReadText()) ?? '');
    } else if (navigator.clipboard?.readText) {
      text = await navigator.clipboard.readText();
    }
    if (text) terminal.paste(text);
  }, []);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        manualCloseRef.current = true;
        wsRef.current.close();
      }
      if (termContextMenuCleanupRef.current) {
        termContextMenuCleanupRef.current();
        termContextMenuCleanupRef.current = null;
      }
      if (terminalRef.current) {
        terminalRef.current.dispose();
      }
    };
  }, []);

  const selectedInfo = allInfos.find((c) => c.name === container);
  const canExec = selectedInfo?.state === 'running';

  useEffect(() => {
    if (!autoSave || !container) return;
    const api = (window as any).electronAPI;
    if (!api?.sessionLogPath) return;
    api
      .sessionLogPath({ kind: 'exec', context, namespace, pod: name, container })
      .then((p: string) => setSavePath(p))
      .catch(() => {});
  }, [autoSave, container, context, namespace, name]);

  const handleSaveAs = useCallback(async (): Promise<boolean> => {
    const api = (window as any).electronAPI;
    if (!api?.sessionLogSaveAs || !container) return false;
    const res = await api.sessionLogSaveAs(
      { kind: 'exec', context, namespace, pod: name, container },
      captureRef.current,
    );
    if (!res?.canceled && res?.path) {
      setSavePath(res.path);
      return true;
    }
    return false;
  }, [container, context, namespace, name]);

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

  useSessionEvent((type) => {
    if (type === 'locked') {
      setSessionLocked(true);
    } else if (type === 'unlocked' || type === 'profile-changed') {
      setSessionLocked(false);
    }
  });

  // When transitioning locked → unlocked, reset auto-connect flag so the
  // existing auto-connect useEffect will fire connect() if canExec && !connected.
  useEffect(() => {
    if (wasLockedRef.current && !sessionLocked) {
      autoConnectedRef.current = false;
    }
    wasLockedRef.current = sessionLocked;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionLocked]);

  // Auto-connect when a running container is selected and not already connected.
  useEffect(() => {
    if (canExec && !connected && !autoConnectedRef.current) {
      autoConnectedRef.current = true;
      connect();
    }
    if (!canExec) {
      autoConnectedRef.current = false;
    }
  }, [canExec, connected, connect]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('mousedown', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', close, true);
    };
  }, [menuOpen]);

  return (
    <div className="exec-tab" style={{ position: 'relative' }}>
      {sessionLocked && !connected && (
        <div className="session-locked-overlay">
          <div className="session-locked-message">
            <span className="session-locked-icon">🔒</span>
            <span>Store locked — unlock to reconnect</span>
          </div>
        </div>
      )}
      <div className="exec-toolbar">
        <label>
          Container:
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            {runningContainers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} [{c.state}{c.ready ? '' : ', not ready'}]
                {c.restartCount > 0 ? ` (${c.restartCount} restarts)` : ''}
              </option>
            ))}
          </select>
        </label>
        {podPhase && (
          <span className={`pod-phase-pill ${podPhase.toLowerCase()}`}>Pod: {podPhase}</span>
        )}
        <button className="exec-connect-btn" onClick={connect} disabled={!canExec || connected}>
          {connected ? 'Connected' : canExec ? 'Connect' : 'Not Running'}
        </button>
        {connected && (
          <button
            className="exec-disconnect-btn"
            onClick={() => {
              manualCloseRef.current = true;
              wsRef.current?.close();
              setConnected(false);
            }}
          >
            Disconnect
          </button>
        )}
        <button
          className="exec-logs-btn"
          title="Open logs window for this pod/container"
          onClick={() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).electronAPI?.openSessionWindow?.({
              kind: 'logs',
              context,
              namespace,
              pod: name,
              container: container || '',
            });
          }}
        >
          Open Logs
        </button>
        <button
          className="exec-files-btn"
          title="Open file browser for this pod (major action)"
          onClick={() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).electronAPI?.openFileTransferWindow?.({
              context,
              namespace,
              pod: name,
              container: container || '',
            });
          }}
        >
          Open Files
        </button>
        <button
          className="exec-files-btn"
          title="Open port-forward manager for this pod"
          onClick={() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).electronAPI?.openPortForwardWindow?.({
              context,
              namespace,
              targetType: 'pod',
              targetName: name,
            });
          }}
        >
          Port Forward
        </button>
        <label className="logs-checkbox" title={savePath || 'Append terminal output to local session log file'}>
          <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} />
          Auto-save
        </label>
        <button className="logs-save-btn" onClick={handleSaveAs} disabled={!container}>
          Save...
        </button>
        {autoSave && savePath && <span className="logs-fetching" title={savePath}>Saving: {savePath.split('/').slice(-2).join('/')}</span>}
        <span className={`exec-status ${connected ? 'connected' : ''}`}>
          {connected ? 'Connected' : error || (canExec ? 'Disconnected' : 'Container not running')}
        </span>
      </div>
      {runningContainers.length > 1 && (
        <div className="container-status-bar">
          {runningContainers.map((c) => (
            <span
              key={c.name}
              className={`container-pill ${c.state} ${c.name === container ? 'active' : ''}`}
              onClick={() => setContainer(c.name)}
              title={`${c.name}: ${c.state}${c.reason ? ' (' + c.reason + ')' : ''} | Ready: ${c.ready ? 'Yes' : 'No'} | Restarts: ${c.restartCount}`}
            >
              <span className={`cpill-dot ${c.state} ${c.ready ? 'ready' : ''}`} />
              {c.name}
              {c.restartCount > 0 && <span className="cpill-restarts">{c.restartCount}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="exec-terminal" ref={termRef} />
      {menuOpen && (
        <div className="context-menu" style={{ left: menuPos.x, top: menuPos.y }} onContextMenu={(e) => e.preventDefault()}>
          <div
            className="context-menu-item"
            onClick={() => {
              void copyFromTerminal();
              setMenuOpen(false);
            }}
          >
            Copy ({primaryKeyLabel}+Shift+C)
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              void pasteIntoTerminal();
              setMenuOpen(false);
            }}
          >
            Paste ({primaryKeyLabel}+Shift+V)
          </div>
        </div>
      )}
    </div>
  );
}
