import React, { useState, useEffect, useCallback, useRef } from 'react';
import { usePodInfo } from '../state/queries';

interface FileEntry {
  name: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified: string;
}

interface TransferState {
  direction: 'download' | 'upload';
  name: string;
  loaded: number;
  total: number;
  filesDone?: number;
  filesTotal?: number;
}

interface FileTransferProps {
  context: string;
  namespace: string;
  pod: string;
  initialContainer?: string;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function joinContainerPath(base: string, name: string): string {
  if (name === '..') {
    const parts = base.replace(/\/$/, '').split('/');
    parts.pop();
    return parts.join('/') || '/';
  }
  if (name === '.') return base;
  const sep = base.endsWith('/') ? '' : '/';
  return base + sep + name;
}

function joinLocalPath(base: string, name: string): string {
  if (name === '..') {
    const parts = base.replace(/\/$/, '').split('/');
    parts.pop();
    return parts.join('/') || '/';
  }
  if (name === '.') return base;
  const sep = base.endsWith('/') ? '' : '/';
  return base + sep + name;
}

function FileIcon({ isDir, isLink }: { isDir: boolean; isLink: boolean }) {
  if (isLink) return <span className="ft-icon ft-icon-link">⇢</span>;
  if (isDir) return <span className="ft-icon ft-icon-dir">▶</span>;
  return <span className="ft-icon ft-icon-file">·</span>;
}

function Breadcrumb({ pathStr, onNavigate }: { pathStr: string; onNavigate: (p: string) => void }) {
  const parts = pathStr.split('/').filter(Boolean);
  return (
    <div className="ft-breadcrumb">
      <span className="ft-breadcrumb-seg" onClick={() => onNavigate('/')}>
        /
      </span>
      {parts.map((seg, i) => {
        const target = '/' + parts.slice(0, i + 1).join('/');
        return (
          <React.Fragment key={i}>
            <span className="ft-breadcrumb-sep">/</span>
            <span className="ft-breadcrumb-seg" onClick={() => onNavigate(target)}>
              {seg}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

interface PaneProps {
  title: string;
  pathStr: string;
  entries: FileEntry[];
  selected: string | null;
  loading: boolean;
  error: string;
  onNavigate: (path: string) => void;
  onSelect: (name: string) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onRefresh: () => void;
}

function FilePane({ title, pathStr, entries, selected, loading, error, onNavigate, onSelect, onDoubleClick, onRefresh }: PaneProps) {
  return (
    <div className="ft-pane">
      <div className="ft-pane-header">
        <span className="ft-pane-title">{title}</span>
        <button className="ft-btn-icon" onClick={onRefresh} title="Refresh" aria-label={`Refresh ${title} pane`}>⟳</button>
      </div>
      <Breadcrumb pathStr={pathStr} onNavigate={onNavigate} />
      <div className="ft-file-list" role="listbox" aria-label={`${title} files`}>
        {loading && <div className="ft-loading">Loading…</div>}
        {error && <div className="ft-error">{error}</div>}
        {!loading && !error && entries.map((entry) => (
          <div
            key={entry.name}
            className={`ft-entry ${entry.isDir ? 'ft-entry-dir' : ''} ${selected === entry.name ? 'ft-entry-selected' : ''}`}
            onClick={() => onSelect(entry.name)}
            onDoubleClick={() => onDoubleClick(entry)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onDoubleClick(entry);
              } else if (e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                onSelect(entry.name);
              }
            }}
            role="option"
            tabIndex={0}
            aria-selected={selected === entry.name}
            aria-label={`${entry.isDir ? 'Directory' : 'File'} ${entry.name}`}
            title={entry.name}
          >
            <FileIcon isDir={entry.isDir} isLink={entry.isLink} />
            <span className="ft-entry-name">{entry.name}</span>
            {!entry.isDir && (
              <span className="ft-entry-size">{formatSize(entry.size)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function FileTransfer({ context, namespace, pod, initialContainer }: FileTransferProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).electronAPI;

  const podInfo = usePodInfo(context, namespace, pod);
  const allContainers = podInfo.data?.containers?.filter((c) => !c.isInit) ?? [];
  const [container, setContainer] = useState(initialContainer || '');

  // Auto-select first running container.
  useEffect(() => {
    if (allContainers.length > 0 && !container) {
      const running = allContainers.find((c) => c.state === 'running');
      setContainer(running ? running.name : allContainers[0].name);
    }
  }, [allContainers, container]);

  // Container pane
  const [containerPath, setContainerPath] = useState('/');
  const [containerEntries, setContainerEntries] = useState<FileEntry[]>([]);
  const [containerSelected, setContainerSelected] = useState<string | null>(null);
  const [containerLoading, setContainerLoading] = useState(false);
  const [containerError, setContainerError] = useState('');

  // Local pane
  const [localPath, setLocalPath] = useState('');
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState('');

  // Transfer
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [transferError, setTransferError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const ensureRemoteDir = useCallback(async (dirPath: string, signal?: AbortSignal) => {
    const config = await api.getDaemonConfig();
    const params = new URLSearchParams({ context, namespace, pod, container, path: dirPath });
    const resp = await fetch(
      `http://127.0.0.1:${config.port}/api/file/mkdir?${params}`,
      { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, signal },
    );
    if (!resp.ok) throw new Error(await resp.text());
  }, [api, context, namespace, pod, container]);

  const fetchContainerEntriesAt = useCallback(async (dirPath: string, signal?: AbortSignal): Promise<FileEntry[]> => {
    const config = await api.getDaemonConfig();
    const params = new URLSearchParams({
      context, namespace, pod, container,
      path: dirPath,
    });
    const resp = await fetch(
      `http://127.0.0.1:${config.port}/api/file/list?${params}`,
      { headers: { Authorization: `Bearer ${config.token}` }, signal },
    );
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json() as { entries: FileEntry[] };
    return data.entries ?? [];
  }, [api, context, namespace, pod, container]);

  const downloadFileToLocal = useCallback(async (
    srcPath: string,
    destPath: string,
    signal: AbortSignal,
    onChunk: (n: number) => void,
  ) => {
    const config = await api.getDaemonConfig();
    const params = new URLSearchParams({ context, namespace, pod, container, path: srcPath });
    const resp = await fetch(
      `http://127.0.0.1:${config.port}/api/file/download?${params}`,
      { headers: { Authorization: `Bearer ${config.token}` }, signal },
    );
    if (!resp.ok) throw new Error(await resp.text());
    const reader = resp.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      onChunk(value.length);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
    await api.localFsSave(destPath, buf.buffer);
  }, [api, context, namespace, pod, container]);

  const uploadLocalFileToPod = useCallback(async (
    srcPath: string,
    destPath: string,
    signal: AbortSignal,
    onBytes: (n: number) => void,
  ) => {
    const rawData: Uint8Array = await api.localFsRead(srcPath);
    const data = new Uint8Array(rawData);
    const config = await api.getDaemonConfig();
    const params = new URLSearchParams({ context, namespace, pod, container, path: destPath });
    const resp = await fetch(
      `http://127.0.0.1:${config.port}/api/file/upload?${params}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}` },
        body: new Blob([data]),
        signal,
      },
    );
    if (!resp.ok) throw new Error(await resp.text());
    onBytes(data.byteLength);
  }, [api, context, namespace, pod, container]);

  // Init local path from home dir.
  useEffect(() => {
    api?.localFsHome?.().then((home: string) => {
      setLocalPath(home);
    });
  }, []);

  const listContainer = useCallback(async (dirPath: string) => {
    if (!container) return;
    setContainerLoading(true);
    setContainerError('');
    setContainerSelected(null);
    try {
      const config = await api.getDaemonConfig();
      const params = new URLSearchParams({
        context, namespace, pod, container,
        path: dirPath,
      });
      const resp = await fetch(
        `http://127.0.0.1:${config.port}/api/file/list?${params}`,
        { headers: { Authorization: `Bearer ${config.token}` } },
      );
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json() as { path: string; entries: FileEntry[] };
      setContainerPath(data.path);
      setContainerEntries(data.entries ?? []);
    } catch (err) {
      setContainerError(String(err));
    } finally {
      setContainerLoading(false);
    }
  }, [context, namespace, pod, container, api]);

  const listLocal = useCallback(async (dirPath: string) => {
    if (!dirPath) return;
    setLocalLoading(true);
    setLocalError('');
    setLocalSelected(null);
    try {
      const entries: FileEntry[] = await api.localFsList(dirPath);
      // Sort: dirs first, then files, both alpha.
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      // Ensure ".." entry at top if not root.
      const hasParent = entries.some((e) => e.name === '..');
      const filtered = entries.filter((e) => e.name !== '.');
      if (!hasParent && dirPath !== '/') {
        filtered.unshift({ name: '..', isDir: true, isLink: false, size: 0, modified: '' });
      }
      setLocalEntries(filtered);
      setLocalPath(dirPath);
    } catch (err) {
      setLocalError(String(err));
    } finally {
      setLocalLoading(false);
    }
  }, [api]);

  // Load container listing when container or path changes.
  useEffect(() => {
    if (container) listContainer(containerPath);
  }, [container]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load local listing when localPath is initialized.
  useEffect(() => {
    if (localPath) listLocal(localPath);
  }, [localPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleContainerDoubleClick = (entry: FileEntry) => {
    if (entry.isDir) {
      listContainer(joinContainerPath(containerPath, entry.name));
    }
  };

  const handleLocalDoubleClick = (entry: FileEntry) => {
    if (entry.isDir) {
      listLocal(joinLocalPath(localPath, entry.name));
    }
  };

  // Download: container → local
  const download = async () => {
    if (!containerSelected) return;
    const selectedEntry = containerEntries.find((e) => e.name === containerSelected);
    if (!selectedEntry) return;

    const srcPath = joinContainerPath(containerPath, containerSelected);

    setTransferError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setTransfer({ direction: 'download', name: containerSelected, loaded: 0, total: 0, filesDone: 0, filesTotal: 0 });

    try {
      if (!selectedEntry.isDir) {
        const destPath = joinLocalPath(localPath, containerSelected);
        await downloadFileToLocal(srcPath, destPath, ctrl.signal, (n) => {
          setTransfer((t) => t ? { ...t, loaded: t.loaded + n, total: Math.max(t.total, t.loaded + n), filesTotal: 1, filesDone: 0 } : t);
        });
        setTransfer((t) => t ? { ...t, filesDone: 1, filesTotal: 1, total: t.loaded } : t);
      } else {
        type Job = { src: string; dest: string; size: number };
        const rootDest = joinLocalPath(localPath, selectedEntry.name);
        await api.localFsMkdir(rootDest);
        const jobs: Job[] = [];
        const stack: Array<{ srcDir: string; destDir: string }> = [{ srcDir: srcPath, destDir: rootDest }];
        while (stack.length > 0) {
          const current = stack.pop()!;
          const entries = await fetchContainerEntriesAt(current.srcDir, ctrl.signal);
          for (const e of entries) {
            if (e.name === '.' || e.name === '..') continue;
            const childSrc = joinContainerPath(current.srcDir, e.name);
            const childDest = joinLocalPath(current.destDir, e.name);
            if (e.isDir) {
              await api.localFsMkdir(childDest);
              stack.push({ srcDir: childSrc, destDir: childDest });
            } else {
              jobs.push({ src: childSrc, dest: childDest, size: Math.max(0, e.size) });
            }
          }
        }
        const totalBytes = jobs.reduce((n, j) => n + j.size, 0);
        setTransfer((t) => t ? { ...t, total: totalBytes, filesTotal: jobs.length, filesDone: 0 } : t);
        for (let i = 0; i < jobs.length; i++) {
          const j = jobs[i];
          await downloadFileToLocal(j.src, j.dest, ctrl.signal, (n) => {
            setTransfer((t) => t ? { ...t, loaded: t.loaded + n } : t);
          });
          setTransfer((t) => t ? { ...t, filesDone: i + 1 } : t);
        }
      }
      await listLocal(localPath);
      setTransfer(null);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setTransferError(`Download failed: ${err}`);
      }
      setTransfer(null);
    }
    abortRef.current = null;
  };

  // Upload: local → container
  const upload = async () => {
    if (!localSelected) return;
    const selectedEntry = localEntries.find((e) => e.name === localSelected);
    if (!selectedEntry) return;

    const srcPath = joinLocalPath(localPath, localSelected);

    setTransferError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setTransfer({ direction: 'upload', name: localSelected, loaded: 0, total: 0, filesDone: 0, filesTotal: 0 });

    try {
      if (!selectedEntry.isDir) {
        const destPath = joinContainerPath(containerPath, localSelected);
        await uploadLocalFileToPod(srcPath, destPath, ctrl.signal, (n) => {
          setTransfer((t) => t ? { ...t, loaded: t.loaded + n, total: Math.max(t.total, t.loaded + n), filesTotal: 1, filesDone: 1 } : t);
        });
      } else {
        type Job = { src: string; dest: string; size: number; isDir: boolean };
        const rootDest = joinContainerPath(containerPath, selectedEntry.name);
        await ensureRemoteDir(rootDest, ctrl.signal);
        const jobs: Job[] = [];
        const stack: Array<{ srcDir: string; destDir: string }> = [{ srcDir: srcPath, destDir: rootDest }];
        while (stack.length > 0) {
          const current = stack.pop()!;
          const entries: FileEntry[] = await api.localFsList(current.srcDir);
          for (const e of entries) {
            if (e.name === '.' || e.name === '..') continue;
            const childSrc = joinLocalPath(current.srcDir, e.name);
            const childDest = joinContainerPath(current.destDir, e.name);
            if (e.isDir) {
              jobs.push({ src: childSrc, dest: childDest, size: 0, isDir: true });
              stack.push({ srcDir: childSrc, destDir: childDest });
            } else {
              jobs.push({ src: childSrc, dest: childDest, size: Math.max(0, e.size), isDir: false });
            }
          }
        }
        const fileJobs = jobs.filter((j) => !j.isDir);
        const totalBytes = fileJobs.reduce((n, j) => n + j.size, 0);
        setTransfer((t) => t ? { ...t, total: totalBytes, filesTotal: fileJobs.length, filesDone: 0 } : t);
        for (const j of jobs) {
          if (j.isDir) {
            await ensureRemoteDir(j.dest, ctrl.signal);
            continue;
          }
          await uploadLocalFileToPod(j.src, j.dest, ctrl.signal, (n) => {
            setTransfer((t) => t ? { ...t, loaded: t.loaded + n } : t);
          });
          setTransfer((t) => t ? { ...t, filesDone: (t.filesDone || 0) + 1 } : t);
        }
      }
      await listContainer(containerPath);
      setTransfer(null);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setTransferError(`Upload failed: ${err}`);
      }
      setTransfer(null);
    }
    abortRef.current = null;
  };

  const cancelTransfer = () => {
    abortRef.current?.abort();
    setTransfer(null);
  };

  const canDownload = !!containerSelected && !transfer &&
    containerEntries.find((e) => e.name === containerSelected);
  const canUpload = !!localSelected && !transfer &&
    localEntries.find((e) => e.name === localSelected);

  const progressPct = transfer && transfer.total > 0
    ? Math.round((transfer.loaded / transfer.total) * 100)
    : null;

  return (
    <div className="ft-root">
      <div className="ft-toolbar">
        {allContainers.length > 1 && (
          <label className="ft-container-select">
            Container:
            <select value={container} onChange={(e) => setContainer(e.target.value)}>
              {allContainers.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} [{c.state}]
                </option>
              ))}
            </select>
          </label>
        )}
        {allContainers.length === 1 && (
          <span className="ft-container-label">{container}</span>
        )}
        <span className="ft-toolbar-spacer" />
        <span className="ft-pod-label">{namespace}/{pod}</span>
      </div>

      <div className="ft-panes">
        <FilePane
          title="Container"
          pathStr={containerPath}
          entries={containerEntries}
          selected={containerSelected}
          loading={containerLoading}
          error={containerError}
          onNavigate={(p) => listContainer(p)}
          onSelect={(name) => setContainerSelected(name === containerSelected ? null : name)}
          onDoubleClick={handleContainerDoubleClick}
          onRefresh={() => listContainer(containerPath)}
        />

        <div className="ft-actions">
          <button
            className="ft-transfer-btn ft-download-btn"
            onClick={download}
            disabled={!canDownload}
            title="Copy selected file/folder from container to local directory"
          >
            To Local →
          </button>
          <button
            className="ft-transfer-btn ft-upload-btn"
            onClick={upload}
            disabled={!canUpload}
            title="Copy selected file/folder from local directory to container"
          >
            ← To Pod
          </button>
        </div>

        <FilePane
          title="Local"
          pathStr={localPath}
          entries={localEntries}
          selected={localSelected}
          loading={localLoading}
          error={localError}
          onNavigate={(p) => listLocal(p)}
          onSelect={(name) => setLocalSelected(name === localSelected ? null : name)}
          onDoubleClick={handleLocalDoubleClick}
          onRefresh={() => listLocal(localPath)}
        />
      </div>

      <div className="ft-status-bar">
        {transfer ? (
          <div className="ft-progress">
            <span className="ft-progress-label">
              {transfer.direction === 'download' ? '↓' : '↑'} {transfer.name}
              {typeof transfer.filesDone === 'number' && typeof transfer.filesTotal === 'number' && transfer.filesTotal > 1
                ? ` (${transfer.filesDone}/${transfer.filesTotal} files)`
                : ''}
              {progressPct !== null ? ` — ${progressPct}%` : ''}
            </span>
            <div className="ft-progress-track">
              <div
                className="ft-progress-fill"
                style={{ width: progressPct !== null ? `${progressPct}%` : '100%', opacity: progressPct === null ? 0.5 : 1 }}
              />
            </div>
            <button className="ft-cancel-btn" onClick={cancelTransfer}>Cancel</button>
          </div>
        ) : transferError ? (
          <span className="ft-status-error">{transferError}</span>
        ) : (
          <span className="ft-status-hint">
            {containerSelected
              ? `Selected: ${containerSelected}`
              : localSelected
              ? `Selected: ${localSelected}`
              : 'Click a file to select · Double-click a folder to open'}
          </span>
        )}
      </div>
    </div>
  );
}
