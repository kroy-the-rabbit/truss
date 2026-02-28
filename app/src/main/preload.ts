import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getDaemonConfig: () => ipcRenderer.invoke('get-daemon-config'),
  getPreferences: () => ipcRenderer.invoke('get-preferences'),
  setExecPathHints: (pathHints: string[]) => ipcRenderer.invoke('set-exec-path-hints', pathHints),
  setEventSuppressionRules: (rules: string[]) => ipcRenderer.invoke('set-event-suppression-rules', rules),
  setThemeMode: (mode: 'system' | 'light' | 'dark' | 'user-css') => ipcRenderer.invoke('set-theme-mode', mode),
  openExternalTerminal: (opts: Record<string, unknown>) => ipcRenderer.invoke('open-external-terminal', opts),
  openSessionWindow: (opts: { kind: 'logs' | 'exec'; context: string; namespace: string; pod: string; container: string }) =>
    ipcRenderer.invoke('open-session-window', opts),
  openPortForwardWindow: (opts?: {
    context?: string;
    namespace?: string;
    targetType?: 'pod' | 'service';
    targetName?: string;
    localPort?: number;
    targetPort?: number;
  }) => ipcRenderer.invoke('open-portforward-window', opts),
  portForwardList: () => ipcRenderer.invoke('port-forward-list'),
  portForwardStart: (opts: {
    context: string;
    namespace: string;
    targetType: 'pod' | 'service';
    targetName: string;
    localPort: number;
    targetPort: number;
  }) => ipcRenderer.invoke('port-forward-start', opts),
  portForwardStop: (id: string) => ipcRenderer.invoke('port-forward-stop', id),
  portForwardOpenUrl: (id: string) => ipcRenderer.invoke('port-forward-open-url', id),
  onAddSessionTab: (callback: (tab: { context: string; namespace: string; pod: string; container: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tab: { context: string; namespace: string; pod: string; container: string }) => callback(tab);
    ipcRenderer.on('add-session-tab', handler);
    return () => ipcRenderer.removeListener('add-session-tab', handler);
  },
  onBeforeClose: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('before-close', handler);
    return () => ipcRenderer.removeListener('before-close', handler);
  },
  confirmWindowClose: () => ipcRenderer.invoke('confirm-window-close'),
  onMenuAction: (callback: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action);
    ipcRenderer.on('menu-action', handler);
    return () => ipcRenderer.removeListener('menu-action', handler);
  },
  onThemeUpdated: (callback: (payload: {
    themeMode: 'system' | 'light' | 'dark' | 'user-css';
    effectiveTheme: 'light' | 'dark';
    userCss: string;
    userCssPath: string;
  }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: {
        themeMode: 'system' | 'light' | 'dark' | 'user-css';
        effectiveTheme: 'light' | 'dark';
        userCss: string;
        userCssPath: string;
      },
    ) => callback(payload);
    ipcRenderer.on('theme-updated', handler);
    return () => ipcRenderer.removeListener('theme-updated', handler);
  },

  // Session event bus: main window renderer → main process → all session windows.
  sessionBroadcast: (type: string) => ipcRenderer.invoke('session-broadcast', type),
  onSessionEvent: (callback: (type: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, type: string) => callback(type);
    ipcRenderer.on('session-event', handler);
    return () => ipcRenderer.removeListener('session-event', handler);
  },

  // Local filesystem IPC (used by file transfer)
  localFsList: (dirPath: string) => ipcRenderer.invoke('local-fs-list', dirPath),
  localFsHome: () => ipcRenderer.invoke('local-fs-home'),
  localFsSave: (filePath: string, data: ArrayBuffer) => ipcRenderer.invoke('local-fs-save', filePath, data),
  localFsRead: (filePath: string) => ipcRenderer.invoke('local-fs-read', filePath),
  localFsMkdir: (dirPath: string) => ipcRenderer.invoke('local-fs-mkdir', dirPath),
  openFileTransferWindow: (opts: { context: string; namespace: string; pod: string; container: string }) =>
    ipcRenderer.invoke('open-filetransfer-window', opts),
  sessionLogAppend: (
    meta: { kind: 'logs' | 'exec'; context: string; namespace: string; pod: string; container: string },
    chunk: string,
  ) => ipcRenderer.invoke('session-log-append', meta, chunk),
  sessionLogPath: (meta: { kind: 'logs' | 'exec'; context: string; namespace: string; pod: string; container: string }) =>
    ipcRenderer.invoke('session-log-path', meta),
  sessionLogSaveAs: (
    meta: { kind: 'logs' | 'exec'; context: string; namespace: string; pod: string; container: string },
    content: string,
  ) => ipcRenderer.invoke('session-log-save-as', meta, content),
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard-write-text', text),
  clipboardReadText: () => ipcRenderer.invoke('clipboard-read-text'),
  yamlOpenExternalEditor: (opts: { context: string; namespace: string; resource: string; name: string; yaml: string }) =>
    ipcRenderer.invoke('yaml-open-external-editor', opts),
  yamlReadExternalEditorFile: (filePath: string) => ipcRenderer.invoke('yaml-read-external-editor-file', filePath),
  yamlCleanupExternalEditorFile: (filePath: string) => ipcRenderer.invoke('yaml-cleanup-external-editor-file', filePath),
  openYamlDiffWindow: (payload: {
    context: string;
    namespace: string;
    resource: string;
    name: string;
    currentYaml: string;
    proposedYaml: string;
  }) => ipcRenderer.invoke('open-yaml-diff-window', payload),
  getYamlDiffPayload: (token: string) => ipcRenderer.invoke('get-yaml-diff-payload', token),
  submitYamlDiffDecision: (token: string, approved: boolean) =>
    ipcRenderer.invoke('submit-yaml-diff-decision', token, approved),

  // Plugin IPC
  pluginList: () => ipcRenderer.invoke('plugin-list'),
  pluginReadFile: (pluginId: string, relativePath: string) =>
    ipcRenderer.invoke('plugin-read-file', pluginId, relativePath),
  pluginStorageGet: (pluginId: string, key: string) =>
    ipcRenderer.invoke('plugin-storage-get', pluginId, key),
  pluginStorageSet: (pluginId: string, key: string, value: unknown) =>
    ipcRenderer.invoke('plugin-storage-set', pluginId, key, value),
  pluginStorageDelete: (pluginId: string, key: string) =>
    ipcRenderer.invoke('plugin-storage-delete', pluginId, key),
  pluginSetEnabled: (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke('plugin-set-enabled', pluginId, enabled),
  openPluginDirectory: () => ipcRenderer.invoke('open-plugin-directory'),
});
