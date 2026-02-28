import React, { Suspense, lazy, useEffect, useCallback, useState, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { TopBar } from './components/TopBar';
import { Breadcrumb } from './components/Breadcrumb';
import { TreeSidebar } from './panes/TreeSidebar';
import { ResourceList } from './components/ResourceList';
import { Inspector } from './panes/Inspector';
import { CommandPalette } from './components/CommandPalette';
import { Modal } from './components/Modal';
import { SetupWizard } from './components/SetupWizard';
import { PasswordPrompt } from './components/PasswordPrompt';
import { useAppStore } from './state/store';
import { fetchSetupAPI, getResourcesClient } from './api/client';
import { PluginProvider } from './plugins';
import { pluginRegistry } from './plugins';
import { useLiveResourceInvalidation } from './hooks/useLiveResourceInvalidation';
import { ToastContainer } from './components/ToastContainer';
import './styles.css';

const MetricsDashboard = lazy(async () => {
  const m = await import('./components/MetricsDashboard');
  return { default: m.MetricsDashboard };
});

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('React error boundary caught:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#ff6b6b', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <h2>Something went wrong</h2>
          <p>{this.state.error.message}</p>
          <pre>{this.state.error.stack}</pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, padding: '8px 16px' }}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10000,
      retry: 2,
    },
  },
});

function AppLayout() {
  const {
    activePane,
    setActivePane,
    activeContext,
    activeNamespace,
    setActiveNamespace,
    selectedKind,
    selectedKindLabel,
    setSelectedKind,
    selectedResource,
    selectedResourceNamespace,
    setSelectedResource,
    readOnly,
    setReadOnly,
    setThemeMode,
    autoLockMinutes,
    setAutoLockMinutes,
    setNeverConfirmStartupBypass,
    setEffectiveTheme,
    setUserCss,
    setUserCssPath,
    setEventSuppressionRules,
    themeMode,
    effectiveTheme,
    userCss,
  } = useAppStore();
  const qc = useQueryClient();
  useLiveResourceInvalidation();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteMode, setCommandPaletteMode] = useState<'command' | 'search'>('command');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [containerPick, setContainerPick] = useState<{
    kind: 'logs' | 'exec';
    context: string;
    namespace: string;
    pod: string;
    containers: Array<{ name: string; isInit?: boolean; state?: string }>;
  } | null>(null);
  const [containerPickIdx, setContainerPickIdx] = useState(0);
  const containerPickListRef = useRef<HTMLDivElement>(null);
  const [appInfo, setAppInfo] = useState<{ name: string; version: string }>({ name: 'Truss', version: 'dev' });
  const splitPaneRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState<number | null>(null);

  const openSessionWindow = useCallback((opts: {
    kind: 'logs' | 'exec';
    context: string;
    namespace: string;
    pod: string;
    container?: string;
  }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.openSessionWindow) return;
    api.openSessionWindow({
      kind: opts.kind,
      context: opts.context,
      namespace: opts.namespace,
      pod: opts.pod,
      container: opts.container || '',
    });
  }, []);

  const openShortcutSession = useCallback(async (kind: 'logs' | 'exec') => {
    if (!selectedResource) return;
    const namespace = selectedResourceNamespace || activeNamespace;
    if (!namespace) return;

    const target = {
      kind,
      context: activeContext,
      namespace,
      pod: selectedResource,
    };

    if (selectedKindLabel !== 'Pod') {
      openSessionWindow(target);
      return;
    }

    try {
      const client = await getResourcesClient();
      const info = await client.getPodInfo({
        context: target.context,
        namespace: target.namespace,
        pod: target.pod,
      });
      const all = (info.containers || []).map((c) => ({ name: c.name, isInit: c.isInit, state: c.state }));
      const candidates = kind === 'exec'
        ? all
            .filter((c) => c.isInit !== true && (c.state || '').toLowerCase() === 'running')
            .sort((a, b) => a.name.localeCompare(b.name))
        : all;
      if (kind === 'exec' && candidates.length === 0) {
        return;
      }
      if (candidates.length <= 1) {
        openSessionWindow({
          ...target,
          container: candidates[0]?.name || '',
        });
        return;
      }
      setContainerPick({
        ...target,
        containers: candidates,
      });
    } catch {
      openSessionWindow(target);
    }
  }, [
    activeContext,
    activeNamespace,
    openSessionWindow,
    selectedKindLabel,
    selectedResource,
    selectedResourceNamespace,
  ]);

  useEffect(() => {
    if (autoLockMinutes <= 0) return;

    let cleanupListeners: (() => void) | null = null;
    let timer: number | null = null;
    let disposed = false;
    let lastActivityAt = Date.now();
    const idleMs = autoLockMinutes * 60 * 1000;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = () => {
      clearTimer();
      timer = window.setTimeout(async () => {
        if (disposed) return;
        const now = Date.now();
        if (now-lastActivityAt < idleMs) {
          schedule();
          return;
        }
        try {
          const resp = await fetchSetupAPI('/api/setup/lock', { method: 'POST' });
          if (resp.ok) {
            const api = (window as any).electronAPI;
            if (api?.sessionBroadcast) await api.sessionBroadcast('locked');
            window.location.reload();
            return;
          }
        } catch {
          // keep session unlocked on transient errors
        }
        lastActivityAt = Date.now();
        schedule();
      }, idleMs);
    };

    const beginTracking = () => {
      const bump = () => {
        lastActivityAt = Date.now();
        schedule();
      };
      const passiveEvents: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'wheel', 'touchstart'];
      const directEvents: Array<keyof WindowEventMap> = ['keydown', 'focus'];
      for (const ev of passiveEvents) window.addEventListener(ev, bump, { passive: true });
      for (const ev of directEvents) window.addEventListener(ev, bump);
      cleanupListeners = () => {
        for (const ev of passiveEvents) window.removeEventListener(ev, bump);
        for (const ev of directEvents) window.removeEventListener(ev, bump);
      };
      bump();
    };

    // Only password-encrypted stores require manual unlock; auto-lock is scoped to that mode.
    fetchSetupAPI('/api/setup-status')
      .then((r) => r.json())
      .then((data: { method?: string }) => {
        if (disposed) return;
        if (data?.method === 'password') {
          beginTracking();
        }
      })
      .catch(() => {
        // If status check fails, do not auto-lock.
      });

    return () => {
      disposed = true;
      clearTimer();
      if (cleanupListeners) cleanupListeners();
    };
  }, [autoLockMinutes]);

  const startHorizontalDrag = useCallback((which: 'left' | 'right', startX: number) => {
    const splitPane = splitPaneRef.current;
    if (!splitPane) return;

    const paneRect = splitPane.getBoundingClientRect();
    const sidebarEl = splitPane.querySelector('.pane.sidebar') as HTMLElement | null;
    const inspectorEl = splitPane.querySelector('.pane.inspector') as HTMLElement | null;
    const startSidebarWidth = sidebarEl?.getBoundingClientRect().width ?? 220;
    const startInspectorWidth = inspectorEl?.getBoundingClientRect().width ?? Math.max(360, paneRect.width * 0.38);

    const minSidebar = 160;
    const minMiddle = 260;
    const minInspector = 260;
    const splitterTotalWidth = 6; // 2 splitters * 3px
    const totalWidth = paneRect.width;

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      if (which === 'left') {
        const maxSidebar = totalWidth - startInspectorWidth - minMiddle - splitterTotalWidth;
        const nextSidebar = Math.min(Math.max(startSidebarWidth + delta, minSidebar), maxSidebar);
        setSidebarWidth(nextSidebar);
      } else {
        const maxInspector = totalWidth - startSidebarWidth - minMiddle - splitterTotalWidth;
        const nextInspector = Math.min(Math.max(startInspectorWidth - delta, minInspector), maxInspector);
        setInspectorWidth(nextInspector);
      }
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTextEntryTarget =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        !!target?.isContentEditable ||
        !!target?.closest('.xterm') ||
        !!target?.closest('.monaco-editor');

      // Tab / Shift+Tab: cycle panes forward / backward.
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const paneOrder: Array<'navigator' | 'list' | 'inspector'> = ['navigator', 'list', 'inspector'];
        const idx = paneOrder.indexOf(activePane);
        setActivePane(e.shiftKey
          ? paneOrder[(idx - 1 + paneOrder.length) % paneOrder.length]
          : paneOrder[(idx + 1) % paneOrder.length]);
        return;
      }

      // Cmd/Ctrl+Up: navigate up (resource -> kind -> namespace)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 'ArrowUp' && !isTextEntryTarget) {
        e.preventDefault();
        if (selectedResource) {
          setSelectedResource('');
        } else if (selectedKind) {
          setSelectedKind(null, '');
        } else if (activeNamespace) {
          setActiveNamespace('');
        }
        return;
      }

      // ↑/↓: navigate resource list or tree depending on focused pane.
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isTextEntryTarget) {
        if (activePane === 'list') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('pane-navigate', { detail: e.key === 'ArrowDown' ? 'down' : 'up' }));
          return;
        }
        if (activePane === 'navigator') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('tree-navigate', { detail: e.key === 'ArrowDown' ? 'down' : 'up' }));
          return;
        }
      }

      // ←/→: expand/collapse tree groups when navigator pane is focused.
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isTextEntryTarget) {
        if (activePane === 'navigator') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('tree-navigate', { detail: e.key === 'ArrowRight' ? 'right' : 'left' }));
          return;
        }
      }

      // Enter/Space: select tree item when navigator focused; open inspector when list focused.
      if ((e.key === 'Enter' || e.key === ' ') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isTextEntryTarget) {
        if (activePane === 'navigator') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('tree-navigate', { detail: 'select' }));
          return;
        }
        if (e.key === 'Enter' && activePane === 'list' && selectedResource) {
          e.preventDefault();
          setActivePane('inspector');
          return;
        }
      }

      // F1: hidden alias for help modal.
      if (e.key === 'F1') {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // '?' key: open keyboard shortcuts/help modal (visible primary binding).
      if (
        e.key === '?' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !isTextEntryTarget
      ) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // Esc: close active overlays.
      if (e.key === 'Escape') {
        if (containerPick) {
          e.preventDefault();
          setContainerPick(null);
          return;
        }
        if (shortcutsOpen) {
          e.preventDefault();
          setShortcutsOpen(false);
          return;
        }
      }

      // Ctrl/Cmd+P or Ctrl/Cmd+K: command palette
      if ((e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'k') && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        setCommandPaletteMode('command');
        setCommandPaletteOpen(true);
        return;
      }

      // Cmd/Ctrl+Shift+M: toggle read-only mode.
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'm' &&
        !isTextEntryTarget
      ) {
        e.preventDefault();
        setReadOnly(!readOnly);
        return;
      }

      // ':' key: open command palette (when not in input/textarea/xterm)
      if (
        e.key === ':' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !isTextEntryTarget
      ) {
        e.preventDefault();
        setCommandPaletteMode('command');
        setCommandPaletteOpen(true);
        return;
      }

      // '/' key: open global search palette (when not in input/textarea/xterm)
      if (
        e.key === '/' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !isTextEntryTarget
      ) {
        e.preventDefault();
        setCommandPaletteMode('search');
        setCommandPaletteOpen(true);
        return;
      }

      // Cmd/Ctrl+1: focus navigator pane.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '1') {
        e.preventDefault();
        setActivePane('navigator');
        return;
      }

      // Cmd/Ctrl+2: focus inspector pane.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '2') {
        e.preventDefault();
        setActivePane('inspector');
        return;
      }

      // Cmd/Ctrl+Shift+S: inspector summary tab.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setActivePane('inspector');
        window.dispatchEvent(new CustomEvent('set-inspector-tab', { detail: 'summary' }));
        return;
      }

      // Cmd/Ctrl+Shift+E: inspector events tab.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setActivePane('inspector');
        window.dispatchEvent(new CustomEvent('set-inspector-tab', { detail: 'events' }));
        return;
      }

      // Cmd/Ctrl+Shift+Y: inspector YAML tab.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        setActivePane('inspector');
        window.dispatchEvent(new CustomEvent('set-inspector-tab', { detail: 'yaml' }));
        return;
      }

      // Cmd/Ctrl+Shift+L: open logs sub-window for selected resource.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (selectedResource) {
          void openShortcutSession('logs');
        }
        return;
      }

      // Cmd/Ctrl+Shift+T: open exec sub-window for selected resource.
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key.toLowerCase() === 't' || e.code === 'KeyT')
      ) {
        e.preventDefault();
        if (selectedResource) {
          void openShortcutSession('exec');
        }
        return;
      }
    },
    [
      activePane,
      activeNamespace,
      containerPick,
      shortcutsOpen,
      readOnly,
      setActiveNamespace,
      setReadOnly,
      selectedKind,
      selectedResource,
      setActivePane,
      setSelectedKind,
      setSelectedResource,
      setCommandPaletteMode,
      openShortcutSession,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Reset focused index when container picker opens.
  useEffect(() => { if (containerPick) setContainerPickIdx(0); }, [containerPick]);

  // Container picker: ↑/↓ navigate, Enter select.
  useEffect(() => {
    if (!containerPick) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setContainerPickIdx((i) => Math.min(i + 1, containerPick.containers.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setContainerPickIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = containerPick.containers[containerPickIdx];
        if (c) {
          openSessionWindow({ kind: containerPick.kind, context: containerPick.context, namespace: containerPick.namespace, pod: containerPick.pod, container: c.name });
          setContainerPick(null);
        }
      }
    };
    // Capture phase so xterm/monaco don't swallow these.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [containerPick, containerPickIdx, openSessionWindow]);

  // Focus the highlighted button in the container picker whenever the index changes.
  useEffect(() => {
    if (!containerPickListRef.current) return;
    const btns = containerPickListRef.current.querySelectorAll<HTMLButtonElement>('.container-pick-item');
    btns[containerPickIdx]?.focus();
  }, [containerPickIdx, containerPick]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.getPreferences) return;

    let mounted = true;
    api
      .getPreferences()
      .then((prefs: {
        themeMode: string;
        eventSuppressionRules?: string[];
        effectiveTheme: 'light' | 'dark';
        userCss: string;
        userCssPath: string;
      }) => {
        if (!mounted) return;
        setThemeMode(prefs.themeMode);
        setEffectiveTheme(prefs.effectiveTheme);
        setUserCss(prefs.userCss || '');
        setUserCssPath(prefs.userCssPath || '');
        setEventSuppressionRules(Array.isArray(prefs.eventSuppressionRules) ? prefs.eventSuppressionRules : []);
      })
      .catch((err: unknown) => console.error('Failed to load preferences', err));

    const cleanup = api.onThemeUpdated?.((payload: {
      themeMode: string;
      effectiveTheme: 'light' | 'dark';
      userCss: string;
      userCssPath: string;
    }) => {
      setThemeMode(payload.themeMode);
      setEffectiveTheme(payload.effectiveTheme);
      setUserCss(payload.userCss || '');
      setUserCssPath(payload.userCssPath || '');
    });

    return () => {
      mounted = false;
      if (cleanup) cleanup();
    };
  }, [setThemeMode, setEffectiveTheme, setUserCss, setUserCssPath, setEventSuppressionRules]);

  useEffect(() => {
    let mounted = true;
    fetchSetupAPI('/api/setup/preferences')
      .then(async (resp) => {
        if (!mounted || !resp.ok) return;
        const prefs = await resp.json() as {
          auto_lock_minutes?: number;
          never_confirm_startup_bypass?: boolean;
        };
        setAutoLockMinutes(typeof prefs.auto_lock_minutes === 'number' ? prefs.auto_lock_minutes : 20);
        setNeverConfirmStartupBypass(!!prefs.never_confirm_startup_bypass);
      })
      .catch(() => {
        // Setup may not be ready yet; keep defaults.
      });
    return () => {
      mounted = false;
    };
  }, [setAutoLockMinutes, setNeverConfirmStartupBypass]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    api?.getAppInfo?.().then((info: { name?: string; version?: string }) => {
      setAppInfo({
        name: info?.name || 'Truss',
        version: info?.version || 'dev',
      });
    }).catch(() => {
      // Keep fallback label.
    });
  }, []);

  useEffect(() => {
    // Resolve which theme extension to apply.
    // 'system' and 'user-css' are special: use the OS-detected tone to find
    // the matching builtin theme ('light' or 'dark').
    const activeThemeId =
      themeMode === 'system' || themeMode === 'user-css' ? effectiveTheme : themeMode;

    const themeExt = pluginRegistry.themeExtensions.find((t) => t.id === activeThemeId);

    // Inject (or update) the theme <style> element.
    const THEME_STYLE_ID = 'truss-theme';
    let themeStyle = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
    if (themeExt) {
      if (!themeStyle) {
        themeStyle = document.createElement('style');
        themeStyle.id = THEME_STYLE_ID;
        document.head.appendChild(themeStyle);
      }
      themeStyle.textContent = themeExt.getCss();
      // Keep data-theme for any user.css or third-party CSS that uses it.
      document.documentElement.setAttribute('data-theme', themeExt.tone ?? 'dark');
    } else {
      themeStyle?.remove();
      document.documentElement.setAttribute('data-theme', effectiveTheme);
    }

    // Inject (or remove) the user.css <style> element.
    const USER_CSS_STYLE_ID = 'truss-user-css';
    let userStyle = document.getElementById(USER_CSS_STYLE_ID) as HTMLStyleElement | null;
    if (themeMode === 'user-css') {
      if (!userStyle) {
        userStyle = document.createElement('style');
        userStyle.id = USER_CSS_STYLE_ID;
        document.head.appendChild(userStyle);
      }
      userStyle.textContent = userCss;
    } else {
      userStyle?.remove();
    }
  }, [themeMode, effectiveTheme, userCss]);

  // Listen for menu actions from the Electron main process.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.onMenuAction) return;

    const cleanup = api.onMenuAction((action: string) => {
      switch (action) {
        case 'refresh':
          qc.invalidateQueries();
          break;
        case 'focus-navigator':
          setActivePane('navigator');
          break;
        case 'focus-inspector':
          setActivePane('inspector');
          break;
        case 'tab-summary':
        case 'tab-yaml':
        case 'tab-events':
        case 'tab-logs':
        case 'tab-exec':
          setActivePane('inspector');
          // Dispatch a custom event that Inspector listens for.
          window.dispatchEvent(new CustomEvent('set-inspector-tab', { detail: action.replace('tab-', '') }));
          break;
        case 'delete-resource':
          window.dispatchEvent(new CustomEvent('delete-resource'));
          break;
        case 'popout-logs':
          window.dispatchEvent(new CustomEvent('popout-action', { detail: 'logs' }));
          break;
        case 'popout-exec':
          window.dispatchEvent(new CustomEvent('popout-action', { detail: 'exec' }));
          break;
        case 'show-shortcuts':
          setShortcutsOpen(true);
          break;
      }
    });

    return cleanup;
  }, [qc, setActivePane]);

  return (
    <div className="app">
      <TopBar />
      <Breadcrumb />
      <div
        className="split-pane"
        ref={splitPaneRef}
        style={
          {
            '--sidebar-width': sidebarWidth ? `${sidebarWidth}px` : undefined,
            '--inspector-width': inspectorWidth ? `${inspectorWidth}px` : undefined,
          } as React.CSSProperties
        }
      >
        <TreeSidebar />
        {selectedKindLabel === 'Overview' ? (
          <div className="pane metrics-full-pane">
            <Suspense fallback={<div className="loading">Loading…</div>}>
              <MetricsDashboard />
            </Suspense>
          </div>
        ) : (
          <>
            <div className="splitter" aria-hidden="true" onMouseDown={(e) => startHorizontalDrag('left', e.clientX)} />
            <ResourceList />
            <div className="splitter" aria-hidden="true" onMouseDown={(e) => startHorizontalDrag('right', e.clientX)} />
            <Inspector />
          </>
        )}
      </div>
      <CommandPalette
        open={commandPaletteOpen}
        mode={commandPaletteMode}
        onClose={() => setCommandPaletteOpen(false)}
      />
      {containerPick && (
        <Modal
          onClose={() => setContainerPick(null)}
          labelledBy="container-pick-title"
          contentClassName="modal-content container-pick-modal"
          initialFocusSelector=".container-pick-item"
        >
            <div className="modal-header">
              <h2 id="container-pick-title">Select Container</h2>
              <button className="modal-close" aria-label="Close container picker" onClick={() => setContainerPick(null)}>×</button>
            </div>
            <div className="container-pick-meta">
              {containerPick.namespace}/{containerPick.pod} · {containerPick.kind.toUpperCase()}
            </div>
            <div
              className="container-pick-list"
              ref={containerPickListRef}
              role="listbox"
              aria-label={`Containers in pod ${containerPick.pod}`}
            >
              {containerPick.containers.map((c, idx) => (
                <button
                  key={c.name}
                  role="option"
                  aria-selected={idx === containerPickIdx}
                  className={`container-pick-item${idx === containerPickIdx ? ' keyboard-focused' : ''}`}
                  onMouseEnter={() => setContainerPickIdx(idx)}
                  onClick={() => {
                    openSessionWindow({
                      kind: containerPick.kind,
                      context: containerPick.context,
                      namespace: containerPick.namespace,
                      pod: containerPick.pod,
                      container: c.name,
                    });
                    setContainerPick(null);
                  }}
                >
                  {c.name}
                  {c.isInit ? <span className="container-pick-tag">init</span> : null}
                </button>
              ))}
            </div>
        </Modal>
      )}
      {shortcutsOpen && (
        <ShortcutsModal
          appName={appInfo.name}
          appVersion={appInfo.version}
          hasResourceSelected={!!selectedResource}
          activePane={activePane}
          onClose={() => setShortcutsOpen(false)}
        />
      )}
      <ToastContainer />
    </div>
  );
}

type ShortcutRow = { key: string; desc: string; active?: boolean; dim?: boolean };
type ShortcutSection = { label: string; pane?: 'navigator' | 'list' | 'inspector'; rows: ShortcutRow[] };

function ShortcutsModal({
  appName,
  appVersion,
  hasResourceSelected,
  activePane,
  onClose,
}: {
  appName: string;
  appVersion: string;
  hasResourceSelected: boolean;
  activePane: 'navigator' | 'list' | 'inspector';
  onClose: () => void;
}) {
  const sections: ShortcutSection[] = [
    {
      label: 'Global',
      rows: [
        { key: '?', desc: 'Show this reference' },
        { key: 'Esc', desc: 'Close modal / overlay' },
        { key: 'Ctrl/Cmd + P  or  K  or  :', desc: 'Command palette' },
        { key: '/', desc: 'Global resource search' },
        { key: 'Ctrl/Cmd + ,', desc: 'Preferences' },
        { key: 'Ctrl/Cmd + Shift + M', desc: 'Toggle Write mode' },
        { key: 'Ctrl/Cmd + W', desc: 'Close window' },
        { key: 'Ctrl/Cmd + Q', desc: 'Quit Truss' },
        { key: 'Ctrl/Cmd + =  /  −', desc: 'Zoom in / out' },
        { key: 'Ctrl/Cmd + 0', desc: 'Reset zoom' },
        { key: 'Ctrl/Cmd + R', desc: 'Reload' },
        { key: 'Ctrl/Cmd + Shift + R', desc: 'Hard reload (bypass cache)' },
        { key: 'Ctrl/Cmd + Shift + I  or  F12', desc: 'Toggle DevTools' },
      ],
    },
    {
      label: 'Pane Navigation',
      rows: [
        { key: 'Tab', desc: 'Next pane', active: true },
        { key: 'Shift + Tab', desc: 'Previous pane', active: true },
        { key: 'Ctrl/Cmd + 1', desc: 'Navigator pane', active: activePane === 'navigator' },
        { key: 'Ctrl/Cmd + 2', desc: 'Inspector pane', active: activePane === 'inspector' },
        { key: 'Ctrl/Cmd + ↑', desc: 'Up: resource → kind → namespace' },
      ],
    },
    {
      label: 'Resource List',
      pane: 'list',
      rows: [
        { key: '↑ / ↓', desc: 'Navigate resources', active: activePane === 'list' },
        { key: 'Enter', desc: 'Open in inspector', active: activePane === 'list' && hasResourceSelected, dim: !hasResourceSelected },
        { key: 'Ctrl/Cmd + Shift + L', desc: 'Open Logs window', active: hasResourceSelected, dim: !hasResourceSelected },
        { key: 'Ctrl/Cmd + Shift + T', desc: 'Open Exec window', active: hasResourceSelected, dim: !hasResourceSelected },
      ],
    },
    {
      label: 'Inspector',
      pane: 'inspector',
      rows: [
        { key: 'Ctrl/Cmd + Shift + S', desc: 'Summary tab', active: activePane === 'inspector' },
        { key: 'Ctrl/Cmd + Shift + E', desc: 'Events tab', active: activePane === 'inspector' },
        { key: 'Ctrl/Cmd + Shift + Y', desc: 'YAML tab', active: activePane === 'inspector' },
      ],
    },
    {
      label: 'Logs window',
      rows: [
        { key: 'Ctrl/Cmd + F', desc: 'Find / filter lines' },
        { key: 'Ctrl/Cmd + C', desc: 'Copy selection' },
        { key: 'Ctrl + Tab', desc: 'Next tab' },
        { key: 'Ctrl + Shift + Tab', desc: 'Previous tab' },
      ],
    },
    {
      label: 'Exec window',
      rows: [
        { key: 'Ctrl/Cmd + Shift + C', desc: 'Copy selection' },
        { key: 'Ctrl/Cmd + Shift + V', desc: 'Paste' },
        { key: 'Ctrl + Tab', desc: 'Next tab' },
        { key: 'Ctrl + Shift + Tab', desc: 'Previous tab' },
      ],
    },
    {
      label: 'YAML Diff window',
      rows: [
        { key: 'Ctrl/Cmd + S', desc: 'Save (approve)' },
        { key: 'Esc', desc: 'Cancel (reject)' },
      ],
    },
    {
      label: 'Port Forward window',
      rows: [
        { key: 'Ctrl/Cmd + Enter', desc: 'Start forward' },
        { key: 'Enter', desc: 'Open URL for selected' },
        { key: 'Delete', desc: 'Stop selected forward' },
      ],
    },
  ];

  return (
    <Modal
      onClose={onClose}
      labelledBy="shortcuts-modal-title"
      contentClassName="modal-content shortcuts-modal"
      initialFocusSelector=".modal-close"
    >
        <div className="modal-header">
          <h2 id="shortcuts-modal-title">Keyboard Shortcuts</h2>
          <button className="modal-close" aria-label="Close keyboard shortcuts" onClick={onClose}>×</button>
        </div>
        <div className="shortcuts-app-meta">{appName} v{appVersion}</div>
        <div className="shortcuts-context-hint">
          Active pane: <strong>{activePane}</strong>
          {hasResourceSelected ? ' · resource selected' : ''}
        </div>
        <div className="shortcuts-sections">
          {sections.map((section) => {
            const isPaneSection = !!section.pane;
            const isCurrent = section.pane === activePane;
            return (
              <div key={section.label} className={`shortcuts-section${isCurrent ? ' shortcuts-section-active' : ''}`}>
                <div className="shortcuts-section-label">{section.label}</div>
                {section.rows.map((row) => (
                  <div
                    key={row.key}
                    className={`shortcuts-row${row.dim ? ' shortcuts-row-disabled' : ''}${row.active && isPaneSection ? ' shortcuts-row-live' : ''}`}
                  >
                    <span className="shortcuts-key">{row.key}</span>
                    <span>{row.desc}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
    </Modal>
  );
}

type SetupState = 'checking' | 'uninitialized' | 'locked' | 'broken' | 'ready';

function SetupRouter() {
  const [setupState, setSetupState] = useState<SetupState>('checking');
  const [brokenError, setBrokenError] = useState('');
  const [checkingStartupGate, setCheckingStartupGate] = useState(false);
  const [showNeverConfirmGate, setShowNeverConfirmGate] = useState(false);
  const [neverConfirmBypass, setNeverConfirmBypass] = useState(false);
  const { setAutoLockMinutes, setNeverConfirmStartupBypass } = useAppStore();

  const checkStatus = useCallback(async () => {
    try {
      const resp = await fetchSetupAPI('/api/setup-status');
      const data = await resp.json();
      if (data.broken) {
        setBrokenError(data.broken_error || 'Unknown error');
        setSetupState('broken');
      } else if (!data.initialized) {
        setSetupState('uninitialized');
      } else if (data.locked) {
        setSetupState('locked');
      } else {
        setSetupState('ready');
      }
    } catch {
      // Daemon not reachable yet — retry shortly.
      setTimeout(checkStatus, 800);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    if (setupState !== 'ready') return;
    let mounted = true;
    setCheckingStartupGate(true);
    fetchSetupAPI('/api/setup/preferences')
      .then(async (resp) => {
        if (!mounted) return;
        if (!resp.ok) {
          setShowNeverConfirmGate(false);
          return;
        }
        const data = await resp.json() as {
          auto_lock_minutes?: number;
          startup_confirmation_required?: boolean;
          never_confirm_startup_bypass?: boolean;
        };
        const minutes = typeof data.auto_lock_minutes === 'number' ? data.auto_lock_minutes : 20;
        const bypass = !!data.never_confirm_startup_bypass;
        setAutoLockMinutes(minutes);
        setNeverConfirmStartupBypass(bypass);
        setNeverConfirmBypass(bypass);
        setShowNeverConfirmGate(!!data.startup_confirmation_required);
      })
      .catch(() => {
        if (!mounted) return;
        setShowNeverConfirmGate(false);
      })
      .finally(() => {
        if (mounted) setCheckingStartupGate(false);
      });
    return () => {
      mounted = false;
    };
  }, [setupState, setAutoLockMinutes, setNeverConfirmStartupBypass]);

  if (setupState === 'checking') {
    return <div className="setup-screen"><div className="setup-card"><p className="setup-subtitle">Connecting to daemon…</p></div></div>;
  }
  if (setupState === 'broken') {
    return <StoreErrorScreen error={brokenError} onReset={() => setSetupState('uninitialized')} />;
  }
  if (setupState === 'uninitialized') {
    return <SetupWizard onComplete={() => setSetupState('ready')} />;
  }
  if (setupState === 'locked') {
    return (
      <PasswordPrompt
        onUnlocked={async () => {
          setSetupState('ready');
          const api = (window as any).electronAPI;
          if (api?.sessionBroadcast) await api.sessionBroadcast('unlocked');
        }}
      />
    );
  }
  if (checkingStartupGate) {
    return <div className="setup-screen"><div className="setup-card"><p className="setup-subtitle">Loading preferences…</p></div></div>;
  }
  if (showNeverConfirmGate) {
    return (
      <NeverModeStartupGate
        bypass={neverConfirmBypass}
        onBypassChange={setNeverConfirmBypass}
        onContinue={async () => {
          if (neverConfirmBypass) {
            try {
              await fetchSetupAPI('/api/setup/preferences/never-confirm-bypass', {
                method: 'POST',
                body: JSON.stringify({ never_confirm_startup_bypass: true }),
              });
              setNeverConfirmStartupBypass(true);
            } catch {
              // Ignore and continue this run.
            }
          }
          setShowNeverConfirmGate(false);
        }}
      />
    );
  }
  return <AppLayout />;
}

function NeverModeStartupGate({
  bypass,
  onBypassChange,
  onContinue,
}: {
  bypass: boolean;
  onBypassChange: (v: boolean) => void;
  onContinue: () => void | Promise<void>;
}) {
  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h1 className="setup-title">Auto-lock is disabled</h1>
        <p className="setup-subtitle" style={{ marginBottom: 14 }}>
          You are in <strong>Never</strong> auto-lock mode. The app will remain unlocked until you lock it manually.
        </p>
        <p className="setup-subtitle" style={{ marginBottom: 18 }}>
          Are you sure you want to continue?
        </p>
        <label className="preferences-checkbox-field" style={{ marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={bypass}
            onChange={(e) => onBypassChange(e.target.checked)}
          />
          Don&apos;t ask again on startup
        </label>
        <button className="setup-btn-primary" onClick={() => void onContinue()}>
          Continue
        </button>
      </div>
    </div>
  );
}

function StoreErrorScreen({ error, onReset }: { error: string; onReset: () => void }) {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState('');

  const handleReset = async () => {
    setResetting(true);
    setResetError('');
    try {
      const resp = await fetchSetupAPI('/api/setup/reset', { method: 'POST' });
      if (resp.ok) {
        onReset();
      } else {
        const data = await resp.json();
        setResetError(data.error || 'Reset failed');
      }
    } catch (err) {
      setResetError(`Error: ${err}`);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h1 className="setup-title">Store Error</h1>
        <p className="setup-subtitle">
          The encrypted context store could not be opened. This may be due to file corruption
          or an incompatible format.
        </p>
        <div className="setup-error" style={{ marginBottom: 20 }}>{error}</div>
        <p className="setup-subtitle" style={{ marginBottom: 20 }}>
          You can reset the store to start fresh. This will permanently delete all stored
          contexts — your clusters are not affected, only the local credentials store.
        </p>
        {resetError && <div className="setup-error" style={{ marginBottom: 12 }}>{resetError}</div>}
        <button
          className="setup-btn-danger"
          onClick={handleReset}
          disabled={resetting}
        >
          {resetting ? 'Resetting…' : 'Reset Store (delete all stored contexts)'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <PluginProvider>
          <SetupRouter />
        </PluginProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
