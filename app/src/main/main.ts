import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, nativeTheme, session, shell, clipboard } from 'electron';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startDaemon, stopDaemon, DaemonConfig, enrichPath } from './daemon';
import { readPluginFileUtf8 } from './pluginFs';

let mainWindow: BrowserWindow | null = null;
let daemonConfig: DaemonConfig | null = null;
let logsWindow: BrowserWindow | null = null;
// Each exec session gets its own window, keyed by "context:namespace:pod:container".
const execWindows = new Map<string, BrowserWindow>();
// Each file-transfer session gets its own window, keyed by "context:namespace:pod".
const fileTransferWindows = new Map<string, BrowserWindow>();
let portForwardWindow: BrowserWindow | null = null;
const trustedFileTransferSenders = new Set<number>();
// BrowserWindow IDs that are allowed to close without the save-on-close prompt.
const closingAllowed = new Set<number>();
const yamlDiffPayloads = new Map<string, {
  context: string;
  namespace: string;
  resource: string;
  name: string;
  currentYaml: string;
  proposedYaml: string;
}>();
const yamlDiffPending = new Map<string, { window: BrowserWindow; resolve: (approved: boolean) => void }>();
let forceAppQuit = false;
const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

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
  proc?: ChildProcess;
}

const portForwards = new Map<string, PortForwardRecord>();
let sessionLocked = false;

// Minimize persistent Chromium artifacts on disk.
app.commandLine.appendSwitch('disable-http-cache');

// Resolve the app icon, works in both dev and production builds.
function getIconPath(): string | undefined {
  const devPath = path.join(app.getAppPath(), 'build', 'icon.png');
  if (fs.existsSync(devPath)) return devPath;
  const prodPath = path.join(process.resourcesPath, 'icon.png');
  if (fs.existsSync(prodPath)) return prodPath;
  return undefined;
}
type ThemeMode = string; // 'system' | 'user-css' | any plugin theme id (e.g. 'dark', 'light')
type EffectiveTheme = 'light' | 'dark';

interface Preferences {
  themeMode: ThemeMode;
  execPathHints: string[];
  eventSuppressionRules: string[];
}

const CONFIG_DIR_NAME = 'truss';
const PREFERENCES_FILE = 'preferences.json';
const USER_CSS_FILE = 'user.css';
const EPHEMERAL_PARTITION = 'truss-ephemeral';
const TRANSIENT_USERDATA_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'blob_storage',
  'Session Storage',
  'Local Storage',
  'Shared Dictionary',
  'SharedStorage',
  'Trust Tokens',
  'Trust Tokens-journal',
  'Cookies',
  'Cookies-journal',
  'Network Persistent State',
  'DIPS',
  'Crashpad',
];
let preferences: Preferences = {
  themeMode: 'system',
  execPathHints: [],
  eventSuppressionRules: ['Node:Ready', 'Node:NodeReady', 'Node:NodeNotReady', '*:deprecatedAnnotation'],
};
const USER_CSS_TEMPLATE = `/* Truss user.css
 *
 * This file is loaded when Theme is set to "user.css".
 * It is applied after the built-in stylesheet.
 *
 * Tips:
 * - Keep this file under version control if you want reproducible themes.
 * - Prefer overriding CSS variables first.
 * - Then target specific components/classes as needed.
 */

/* ------------------------------------------------------------------
 * 1) Global Palette (recommended starting point)
 * ------------------------------------------------------------------ */
:root {
  --bg-primary: #10151c;
  --bg-secondary: #151d26;
  --bg-surface: #1d2733;
  --bg-hover: #243243;
  --bg-selected: #2a3b4f;

  --text-primary: #d7e4f2;
  --text-secondary: #9cb2c9;
  --text-dim: #6f859d;

  --accent: #4db6ff;
  --accent-hover: #7cc9ff;
  --success: #4db6ff;
  --error: #b596ff;
  --warning: #f5be64;
  --border: #2f3f52;
  --pane-focus: #4db6ff;
}

/* Optional light variant if you keep Theme=system and want OS-aware look.
@media (prefers-color-scheme: light) {
  :root {
    --bg-primary: #f4f7fb;
    --bg-secondary: #e8eef6;
    --bg-surface: #ffffff;
    --bg-hover: #edf3fb;
    --bg-selected: #dce8f9;
    --text-primary: #132238;
    --text-secondary: #314b6d;
    --text-dim: #7088a4;
    --accent: #0b72d0;
    --accent-hover: #0a63b5;
    --success: #0b72d0;
    --error: #7b61d9;
    --warning: #9e6400;
    --border: #c6d5e8;
    --pane-focus: #0b72d0;
  }
}
*/

/* ------------------------------------------------------------------
 * 2) Density / Typography
 * ------------------------------------------------------------------ */
body {
  font-size: 13px;
  line-height: 1.35;
}

/* Slightly denser tables/lists */
.resource-item,
.kind-item,
.tree-row {
  min-height: 22px;
}

/* ------------------------------------------------------------------
 * 3) Top Bar and Inputs
 * ------------------------------------------------------------------ */
.top-bar {
  border-bottom-width: 1px;
}

.top-bar select,
.top-bar input,
.readonly-toggle input {
  border-radius: 4px;
}

/* ------------------------------------------------------------------
 * 4) Pane Accents
 * ------------------------------------------------------------------ */
.pane.focused {
  border-top-width: 2px;
}

.splitter {
  width: 3px;
}

/* ------------------------------------------------------------------
 * 5) Buttons / Interactive States
 * ------------------------------------------------------------------ */
button,
.btn {
  border-radius: 4px;
}

button:hover,
.btn:hover {
  filter: brightness(1.05);
}

button:active,
.btn:active {
  transform: translateY(1px);
}

/* ------------------------------------------------------------------
 * 6) Logs / Terminal-ish Areas
 * ------------------------------------------------------------------ */
.logs-output,
.xterm,
pre,
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

/* ------------------------------------------------------------------
 * 7) Scrollbars (WebKit/Blink)
 * ------------------------------------------------------------------ */
*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

*::-webkit-scrollbar-thumb {
  background: var(--bg-selected);
  border: 2px solid var(--bg-primary);
  border-radius: 8px;
}

*::-webkit-scrollbar-track {
  background: var(--bg-primary);
}

/* ------------------------------------------------------------------
 * 8) Selection
 * ------------------------------------------------------------------ */
::selection {
  background: color-mix(in srgb, var(--accent) 35%, transparent);
  color: var(--text-primary);
}
`;

function getConfigDir() {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return path.join(os.homedir(), '.config', CONFIG_DIR_NAME);
  }
  return path.join(app.getPath('appData'), CONFIG_DIR_NAME);
}

function getPreferencesPath() {
  return path.join(getConfigDir(), PREFERENCES_FILE);
}

function getUserCssPath() {
  return path.join(getConfigDir(), USER_CSS_FILE);
}

function getSessionLogsDir() {
  return path.join(getConfigDir(), 'session-logs');
}

function removePathIfExists(targetPath: string) {
  try {
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`Failed to remove transient path ${targetPath}:`, err);
  }
}

async function wipeTransientSessionData() {
  const ses = session.fromPartition(EPHEMERAL_PARTITION);
  try {
    await ses.clearCache();
  } catch (err) {
    console.warn('Failed to clear cache', err);
  }
  try {
    await ses.clearStorageData({
      storages: [
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'serviceworkers',
        'shadercache',
        'websql',
        'cachestorage',
      ],
    });
  } catch (err) {
    console.warn('Failed to clear storage data', err);
  }
}

function wipeTransientUserDataDirs() {
  const userDataDir = app.getPath('userData');
  for (const rel of TRANSIENT_USERDATA_DIRS) {
    removePathIfExists(path.join(userDataDir, rel));
  }
}

function sanitizePathPart(v: string): string {
  return v.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'unknown';
}

function timestampForFilename(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

const SESSION_LOG_STAMP = timestampForFilename(new Date());
const EXTERNAL_YAML_DIR = 'external-yaml-edits';

function sessionLogPath(meta: { kind: 'logs' | 'exec'; context: string; namespace: string; pod: string; container: string }) {
  const day = new Date().toISOString().slice(0, 10);
  const base = path.join(getSessionLogsDir(), day, sanitizePathPart(meta.context), sanitizePathPart(meta.namespace));
  const pod = sanitizePathPart(meta.pod);
  const container = sanitizePathPart(meta.container || 'default');
  return path.join(base, `${pod}--${container}--${meta.kind}--${SESSION_LOG_STAMP}.log`);
}

function getExternalYamlDir(): string {
  return path.join(app.getPath('temp'), 'truss', EXTERNAL_YAML_DIR);
}

function sanitizeFilenamePart(v: string): string {
  return (v || 'unknown').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'unknown';
}

function assertExternalYamlPath(targetPath: string): string {
  const baseDir = path.resolve(getExternalYamlDir());
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    throw new Error('Invalid external YAML path');
  }
  return resolved;
}

function loadPreferences() {
  try {
    const file = fs.readFileSync(getPreferencesPath(), 'utf8');
    const parsed = JSON.parse(file) as Partial<Preferences>;
    if (typeof parsed.themeMode === 'string' && parsed.themeMode) {
      preferences.themeMode = parsed.themeMode;
    }
    if (Array.isArray(parsed.execPathHints)) {
      preferences.execPathHints = sanitizeExecPathHints(parsed.execPathHints);
    }
    if (Array.isArray(parsed.eventSuppressionRules)) {
      preferences.eventSuppressionRules = sanitizeEventSuppressionRules(parsed.eventSuppressionRules);
    }
  } catch {
    // Defaults are applied when no preferences file exists or parsing fails.
  }
}

function sanitizeExecPathHints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > 512) continue;
    unique.add(trimmed);
    if (unique.size >= 48) break;
  }
  return Array.from(unique);
}

function sanitizeEventSuppressionRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const line = item.trim();
    if (!line) continue;
    if (line.length > 256) continue;
    unique.add(line);
    if (unique.size >= 128) break;
  }
  return Array.from(unique);
}

// Derive the Electron nativeTheme source from a theme mode string.
// Plugin themes pass an explicit tone via the IPC call; fall back on id matching.
function nativeSourceFor(mode: string, tone?: string): 'system' | 'light' | 'dark' {
  if (tone === 'light' || tone === 'dark' || tone === 'system') return tone;
  if (mode === 'system') return 'system';
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  if (mode === 'user-css') return 'system';
  return 'system'; // unknown plugin theme — let OS decide
}

function savePreferences() {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(getPreferencesPath(), JSON.stringify(preferences, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function ensureUserCssTemplate() {
  const userCssPath = getUserCssPath();
  const dir = path.dirname(userCssPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(userCssPath)) {
    fs.writeFileSync(userCssPath, USER_CSS_TEMPLATE, { encoding: 'utf8', mode: 0o600 });
  }
}

function effectiveTheme(): EffectiveTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function readUserCss(): string {
  try {
    return fs.readFileSync(getUserCssPath(), 'utf8');
  } catch {
    return '';
  }
}

function sendThemeUpdate(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  win.webContents.send('theme-updated', {
    themeMode: preferences.themeMode,
    effectiveTheme: effectiveTheme(),
    userCss: readUserCss(),
    userCssPath: getUserCssPath(),
  });
}

function installWindowContextMenu(win: BrowserWindow) {
  win.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    } else {
      // For read-only content (e.g. the logs <pre>), write params.selectionText directly
      // via the main-process clipboard rather than relying on webContents.copy(), which
      // can silently fail when focus is not on the element that owns the selection.
      template.push(
        {
          label: 'Copy',
          enabled: !!(params.selectionText),
          click: () => { clipboard.writeText(params.selectionText); },
        },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    }
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function broadcastThemeUpdate() {
  if (mainWindow) sendThemeUpdate(mainWindow);
  if (logsWindow && !logsWindow.isDestroyed()) sendThemeUpdate(logsWindow);
  for (const win of execWindows.values()) {
    if (!win.isDestroyed()) sendThemeUpdate(win);
  }
  for (const win of fileTransferWindows.values()) {
    if (!win.isDestroyed()) sendThemeUpdate(win);
  }
}

function broadcastSessionEvent(type: string) {
  const targets = [
    logsWindow,
    portForwardWindow,
    ...execWindows.values(),
    ...fileTransferWindows.values(),
  ];
  for (const win of targets) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('session-event', type);
    }
  }
}

ipcMain.handle('session-broadcast', (_event, type: string) => {
  if (type === 'locked') {
    sessionLocked = true;
    for (const pf of portForwards.values()) {
      if (pf.status === 'running' || pf.status === 'starting') {
        stopPortForwardSession(pf);
        pf.status = 'stopped';
        pf.stoppedAt = new Date().toISOString();
        pf.message = 'Stopped: store locked';
        pf.proc = undefined;
      }
    }
  } else if (type === 'unlocked') {
    sessionLocked = false;
  }
  broadcastSessionEvent(type);
});

function applyThemeMode(mode: ThemeMode, tone?: string, persist = true) {
  preferences.themeMode = mode;
  nativeTheme.themeSource = nativeSourceFor(mode, tone);
  if (persist) savePreferences();
  buildMenu();
  broadcastThemeUpdate();
}

function buildMenu() {
  // Use an in-app F1 modal for shortcuts/help; no native File/Edit/View menu.
  Menu.setApplicationMenu(null);
}

// Attach standard window keyboard shortcuts to a BrowserWindow via before-input-event,
// compensating for the null app menu.
//
// suppressCtrlW: on non-macOS exec windows Ctrl+W is "delete word backward" in the terminal.
// suppressCtrlR: on exec windows Ctrl+R is "reverse history search" in the terminal.
function attachWindowShortcuts(
  win: BrowserWindow,
  opts: { suppressCtrlW?: boolean; suppressCtrlR?: boolean } = {},
) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isMac = process.platform === 'darwin';
    const primaryHeld = isMac ? input.meta : input.control;
    const key = input.key.toLowerCase();

    // F12: toggle DevTools (no modifier required)
    if (key === 'f12' && !primaryHeld && !input.shift && !input.alt) {
      win.webContents.toggleDevTools();
      event.preventDefault();
      return;
    }

    if (!primaryHeld || input.alt) return;

    // Ctrl/Cmd + Shift + … shortcuts
    if (input.shift) {
      if (key === 'i') {
        // Ctrl+Shift+I / Cmd+Option+I: toggle DevTools
        win.webContents.toggleDevTools();
        event.preventDefault();
      } else if (key === 'r' && !opts.suppressCtrlR) {
        // Ctrl+Shift+R: hard reload (bypass cache)
        win.webContents.reloadIgnoringCache();
        event.preventDefault();
      } else if (key === '+') {
        // Ctrl/Cmd + Shift + = (i.e. "+") — zoom in (standard on many keyboards)
        win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 1);
        event.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + (no shift) shortcuts
    if (key === 'w') {
      if (opts.suppressCtrlW && !isMac) return;
      win.close();
    } else if (key === 'q') {
      const openSubapps =
        (logsWindow && !logsWindow.isDestroyed() ? 1 : 0) +
        Array.from(execWindows.values()).filter((w) => !w.isDestroyed()).length +
        Array.from(fileTransferWindows.values()).filter((w) => !w.isDestroyed()).length +
        (portForwardWindow && !portForwardWindow.isDestroyed() ? 1 : 0);
      const detail = openSubapps > 0
        ? `${openSubapps} active session window${openSubapps === 1 ? '' : 's'} will also be closed.`
        : 'The daemon and all active sessions will be stopped.';
      const choice = dialog.showMessageBoxSync(BrowserWindow.getFocusedWindow() ?? win, {
        type: 'warning',
        buttons: ['Cancel', 'Quit'],
        defaultId: 1,
        cancelId: 0,
        title: 'Quit Truss',
        message: 'Are you sure you want to quit Truss?',
        detail,
      });
      if (choice === 1) {
        forceAppQuit = true;
        app.quit();
      }
    } else if (key === '=' || key === '+') {
      // Zoom in: Ctrl/Cmd + = (common) or Ctrl/Cmd + + (numpad)
      win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 1);
      event.preventDefault();
    } else if (key === '-') {
      // Zoom out: Ctrl/Cmd + -
      win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 1);
      event.preventDefault();
    } else if (key === '0') {
      // Reset zoom: Ctrl/Cmd + 0
      win.webContents.setZoomLevel(0);
      event.preventDefault();
    } else if (key === 'r' && !opts.suppressCtrlR) {
      // Reload: Ctrl/Cmd + R
      win.webContents.reload();
      event.preventDefault();
    }
  });
}

// Intercept the close event on logs/exec windows so the renderer can offer to save
// session content before the window is destroyed.  The renderer calls confirm-window-close
// when it is ready to proceed; we then add the window ID to closingAllowed and retry.
function attachCloseWithSave(win: BrowserWindow) {
  win.on('close', (e) => {
    if (closingAllowed.has(win.id)) {
      closingAllowed.delete(win.id);
      return; // Allowed — let the close proceed.
    }
    e.preventDefault();
    win.webContents.send('before-close');
  });
}

ipcMain.handle('confirm-window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    closingAllowed.add(win.id);
    win.close();
  }
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Truss',
    icon: getIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      partition: EPHEMERAL_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installWindowContextMenu(mainWindow);
  attachWindowShortcuts(mainWindow);

  // In development, load from Vite dev server.
  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) sendThemeUpdate(mainWindow);
  });
}

// Handle "open session window" requests (logs/exec as singleton windows with tabs).
ipcMain.handle('open-session-window', (_event, opts: Record<string, unknown>) => {
  const { kind, context, namespace, pod, container } = opts as {
    kind: 'logs' | 'exec';
    context: string;
    namespace: string;
    pod: string;
    container: string;
  };

  // Logs: singleton window with tabs.
  if (kind === 'logs') {
    if (logsWindow && !logsWindow.isDestroyed()) {
      logsWindow.focus();
      logsWindow.webContents.send('add-session-tab', { context, namespace, pod, container: container || '' });
      return { ok: true };
    }

    const win = new BrowserWindow({
      width: 900,
      height: 650,
      title: `${namespace}/${pod} — Logs`,
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        partition: EPHEMERAL_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    installWindowContextMenu(win);
    const params = new URLSearchParams({ session: 'logs', context, namespace, pod, container: container || '' });
    if (process.env.VITE_DEV_SERVER_URL) {
      win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${params}`);
    } else {
      win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { search: params.toString() });
    }
    logsWindow = win;
    attachWindowShortcuts(win);
    attachCloseWithSave(win);
    win.on('closed', () => { logsWindow = null; });
    win.webContents.on('did-finish-load', () => sendThemeUpdate(win));
    return { ok: true };
  }

  // Exec: one window per pod (keyed by identity so reopening the same pod focuses it).
  const execKey = `${context}:${namespace}:${pod}:${container || ''}`;
  const existingExec = execWindows.get(execKey);
  if (existingExec && !existingExec.isDestroyed()) {
    existingExec.focus();
    return { ok: true };
  }

  const execWin = new BrowserWindow({
    width: 900,
    height: 650,
    title: `${namespace}/${pod} — Exec`,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      partition: EPHEMERAL_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installWindowContextMenu(execWin);
  const execParams = new URLSearchParams({ session: 'exec', context, namespace, pod, container: container || '' });
  if (process.env.VITE_DEV_SERVER_URL) {
    execWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${execParams}`);
  } else {
    execWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { search: execParams.toString() });
  }
  execWindows.set(execKey, execWin);
  // Suppress Ctrl+W on non-macOS (delete word backward) and Ctrl+R (reverse history search).
  attachWindowShortcuts(execWin, { suppressCtrlW: true, suppressCtrlR: true });
  attachCloseWithSave(execWin);
  execWin.on('closed', () => { execWindows.delete(execKey); });
  execWin.webContents.on('did-finish-load', () => sendThemeUpdate(execWin));

  return { ok: true };
});

ipcMain.handle('open-portforward-window', async (_event, opts: Record<string, unknown> = {}) => {
  if (portForwardWindow && !portForwardWindow.isDestroyed()) {
    portForwardWindow.focus();
    return { ok: true };
  }

  const targetPortProvided = typeof opts.targetPort === 'number' && Number.isFinite(opts.targetPort);
  const localPortProvided = typeof opts.localPort === 'number' && Number.isFinite(opts.localPort);
  const prefill: {
    context: string;
    namespace: string;
    targetType: 'pod' | 'service';
    targetName: string;
    localPort: number;
    targetPort: number;
  } = {
    context: typeof opts.context === 'string' ? opts.context : '',
    namespace: typeof opts.namespace === 'string' ? opts.namespace : '',
    targetType: opts.targetType === 'service' ? 'service' : 'pod',
    targetName: typeof opts.targetName === 'string' ? opts.targetName : '',
    localPort: localPortProvided ? Number(opts.localPort) : 0,
    targetPort: targetPortProvided ? Number(opts.targetPort) : 0,
  };

  if (!targetPortProvided && prefill.targetName) {
    const detected = detectDefaultTargetPort(prefill.context, prefill.namespace, prefill.targetType, prefill.targetName);
    if (detected) {
      prefill.targetPort = detected;
      if (!localPortProvided || prefill.localPort <= 0) {
        prefill.localPort = detected;
      }
    }
  }
  if (prefill.localPort <= 0) prefill.localPort = 8080;
  if (prefill.targetPort <= 0) prefill.targetPort = 8080;

  const win = new BrowserWindow({
    width: 980,
    height: 680,
    title: 'Port Forward Manager',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      partition: EPHEMERAL_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installWindowContextMenu(win);
  const params = new URLSearchParams({
    session: 'port-forward',
    context: prefill.context,
    namespace: prefill.namespace,
    targetType: prefill.targetType,
    targetName: prefill.targetName,
    localPort: String(prefill.localPort),
    targetPort: String(prefill.targetPort),
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${params}`);
  } else {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { search: params.toString() });
  }
  portForwardWindow = win;
  attachWindowShortcuts(win);
  win.on('closed', () => { portForwardWindow = null; });
  win.webContents.on('did-finish-load', () => sendThemeUpdate(win));
  return { ok: true };
});

ipcMain.handle('port-forward-list', () => {
  return Array.from(portForwards.values()).map(sanitizePortForward);
});

ipcMain.handle('port-forward-start', (_event, opts: Record<string, unknown>) => {
  if (sessionLocked) {
    throw new Error('Store is locked; unlock before starting a port-forward');
  }
  const context = typeof opts.context === 'string' ? opts.context.trim() : '';
  const namespace = typeof opts.namespace === 'string' ? opts.namespace.trim() : '';
  const targetType = opts.targetType === 'service' ? 'service' : 'pod';
  const targetName = typeof opts.targetName === 'string' ? opts.targetName.trim() : '';
  const localPort = Number(opts.localPort);
  const targetPort = Number(opts.targetPort);

  if (!namespace || !targetName || !Number.isFinite(localPort) || !Number.isFinite(targetPort) || localPort <= 0 || targetPort <= 0) {
    throw new Error('Invalid port forward parameters');
  }

  const existing = Array.from(portForwards.values()).find(
    (p) =>
      p.context === context &&
      p.namespace === namespace &&
      p.targetType === targetType &&
      p.targetName === targetName &&
      p.localPort === localPort &&
      p.targetPort === targetPort &&
      (p.status === 'starting' || p.status === 'running'),
  );
  if (existing) {
    return sanitizePortForward(existing);
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const targetRef = `${targetType === 'service' ? 'svc' : 'pod'}/${targetName}`;
  const args = ['port-forward', '-n', namespace, targetRef, `${localPort}:${targetPort}`];
  if (context) args.push('--context', context);

  const proc = spawn('kubectl', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: enrichPath(preferences.execPathHints),
    },
  });

  const rec: PortForwardRecord = {
    id,
    context,
    namespace,
    targetType,
    targetName,
    localPort,
    targetPort,
    status: 'starting',
    startedAt: new Date().toISOString(),
    pid: proc.pid,
    output: '',
    proc,
  };
  portForwards.set(id, rec);

  proc.stdout.on('data', (buf) => {
    const line = String(buf);
    rec.output = trimPortForwardOutput(rec.output + line);
    if (rec.status === 'starting' && line.toLowerCase().includes('forwarding from')) {
      rec.status = 'running';
      rec.message = 'Forwarding';
    }
  });

  proc.stderr.on('data', (buf) => {
    const line = String(buf);
    rec.output = trimPortForwardOutput(rec.output + line);
    const msg = line.trim();
    if (msg) {
      rec.message = msg;
    }
    if (rec.status === 'starting') {
      rec.status = 'error';
      rec.message = derivePortForwardMessage(rec.output, msg || 'Port-forward failed');
    } else if (
      line.toLowerCase().includes('error occurred forwarding') ||
      line.toLowerCase().includes('lost connection to pod')
    ) {
      rec.status = 'error';
      rec.message = derivePortForwardMessage(rec.output, msg || 'Port-forward failed');
    }
  });

  proc.on('error', (err) => {
    rec.status = 'error';
    rec.message = String(err.message || err);
    rec.stoppedAt = new Date().toISOString();
    rec.proc = undefined;
  });

  proc.on('close', (code) => {
    if (rec.status !== 'error') {
      rec.status = code === 0 ? 'stopped' : 'error';
      const fallback = code === 0 ? 'Stopped' : `Exited with code ${String(code)}`;
      rec.message = derivePortForwardMessage(rec.output, fallback);
    }
    rec.stoppedAt = new Date().toISOString();
    rec.proc = undefined;
  });

  return sanitizePortForward(rec);
});

ipcMain.handle('port-forward-stop', (_event, id: string) => {
  const rec = portForwards.get(String(id));
  if (!rec) return { ok: false };
  stopPortForwardSession(rec);
  rec.status = 'stopped';
  rec.stoppedAt = new Date().toISOString();
  rec.message = 'Stopped';
  rec.proc = undefined;
  return { ok: true };
});

ipcMain.handle('port-forward-open-url', (_event, id: string) => {
  if (sessionLocked) throw new Error('Store is locked');
  const rec = portForwards.get(String(id));
  if (!rec) throw new Error('Port-forward session not found');
  const url = `http://127.0.0.1:${rec.localPort}`;
  void shell.openExternal(url);
  return { ok: true, url };
});

// Handle daemon config requests from renderer.
ipcMain.handle('get-daemon-config', () => {
  return daemonConfig;
});

ipcMain.handle('get-preferences', () => ({
  themeMode: preferences.themeMode,
  execPathHints: preferences.execPathHints,
  eventSuppressionRules: preferences.eventSuppressionRules,
  effectiveTheme: effectiveTheme(),
  userCss: readUserCss(),
  userCssPath: getUserCssPath(),
}));

ipcMain.handle('set-exec-path-hints', (_event, pathHints: unknown) => {
  preferences.execPathHints = sanitizeExecPathHints(pathHints);
  savePreferences();
  return { execPathHints: preferences.execPathHints };
});

ipcMain.handle('set-event-suppression-rules', (_event, rules: unknown) => {
  preferences.eventSuppressionRules = sanitizeEventSuppressionRules(rules);
  savePreferences();
  return { eventSuppressionRules: preferences.eventSuppressionRules };
});

ipcMain.handle('get-app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
}));

ipcMain.handle('set-theme-mode', (_event, mode: unknown, tone?: unknown) => {
  if (typeof mode !== 'string' || !mode) {
    throw new Error(`invalid theme mode: ${String(mode)}`);
  }
  applyThemeMode(mode, typeof tone === 'string' ? tone : undefined);
  return {
    themeMode: preferences.themeMode,
    effectiveTheme: effectiveTheme(),
    userCss: readUserCss(),
    userCssPath: getUserCssPath(),
  };
});

// Handle "open in system terminal" requests.
function shellEscapePosix(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function shellEscapeCmd(arg: string): string {
  // Keep cmd.exe metacharacters inert while preserving argument boundaries.
  return `"${arg.replace(/[%^&|<>()!"]/g, '^$&')}"`;
}

ipcMain.handle('open-external-terminal', (_event, opts: Record<string, unknown>) => {
  const { type, context, namespace, pod, container, tailLines, timestamps } = opts as {
    type: string;
    context: string;
    namespace: string;
    pod: string;
    container: string;
    tailLines?: number;
    timestamps?: boolean;
  };

  let cmd: string;
  let args: string[];

  if (type === 'exec') {
    cmd = 'kubectl';
    args = ['exec', '-it', '-n', namespace, pod, '-c', container];
    if (context) args.push('--context', context);
    args.push('--', '/bin/bash', '-c', 'exec bash 2>/dev/null || exec sh');
  } else {
    // logs
    cmd = 'kubectl';
    args = ['logs', '-f', '-n', namespace, pod, '-c', container];
    if (context) args.push('--context', context);
    if (tailLines && tailLines > 0) args.push('--tail', String(tailLines));
    if (timestamps) args.push('--timestamps');
  }

  const fullCmdPosix = [cmd, ...args].map(shellEscapePosix).join(' ');
  const fullCmdCmdExe = [cmd, ...args].map(shellEscapeCmd).join(' ');

  const platform = process.platform;
  if (platform === 'linux') {
    const holdOpenCmd = `${fullCmdPosix}; exec bash`;
    const terminals = [
      { cmd: 'gnome-terminal', args: ['--', 'bash', '-lc', holdOpenCmd] },
      { cmd: 'konsole', args: ['-e', 'bash', '-lc', holdOpenCmd] },
      { cmd: 'xterm', args: ['-e', 'bash', '-lc', holdOpenCmd] },
    ];
    trySpawnTerminal(terminals);
  } else if (platform === 'darwin') {
    const escaped = `${fullCmdPosix}; exec bash`
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${escaped}"`], { detached: true, stdio: 'ignore' });
  } else if (platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', fullCmdCmdExe], { detached: true, stdio: 'ignore' });
  }

  return { ok: true };
});

function trySpawnTerminal(terminals: Array<{ cmd: string; args: string[] }>) {
  if (terminals.length === 0) return;
  const [first, ...rest] = terminals;
  const proc = spawn(first.cmd, first.args, { detached: true, stdio: 'ignore' });
  proc.on('error', () => {
    trySpawnTerminal(rest);
  });
  proc.unref();
}

function trimPortForwardOutput(out: string): string {
  if (out.length <= 64_000) return out;
  return out.slice(out.length - 64_000);
}

function derivePortForwardMessage(output: string, fallback: string): string {
  const lower = output.toLowerCase();
  if (lower.includes('connect: connection refused') || lower.includes('failed to connect to localhost')) {
    return 'Target port is not listening in the workload. Verify target port or use the Service target.';
  }
  if (lower.includes('address already in use')) {
    return 'Local port is already in use. Pick a different local port.';
  }
  if (lower.includes('forbidden')) {
    return 'Kubernetes API denied port-forward. Check RBAC permissions.';
  }
  if (lower.includes('lost connection to pod')) {
    return 'Connection to pod was lost. Pod may have restarted or is unreachable.';
  }
  return fallback;
}

function detectDefaultTargetPort(
  context: string,
  namespace: string,
  targetType: 'pod' | 'service',
  targetName: string,
): number | undefined {
  if (!namespace || !targetName) return undefined;
  const resource = targetType === 'service' ? 'service' : 'pod';
  const jsonPath = targetType === 'service'
    ? `{.spec.ports[*].port}`
    : `{.spec.containers[*].ports[*].containerPort}`;
  const args = ['get', resource, targetName, '-n', namespace, '-o', `jsonpath=${jsonPath}`];
  if (context) args.push('--context', context);
  const res = spawnSync('kubectl', args, {
    encoding: 'utf8',
    timeout: 6000,
    env: {
      ...process.env,
      PATH: enrichPath(preferences.execPathHints),
    },
  });
  if (res.status !== 0) return undefined;
  const text = String(res.stdout || '');
  const match = text.match(/\b(\d{2,5})\b/);
  if (!match) return undefined;
  const p = Number(match[1]);
  if (!Number.isFinite(p) || p <= 0 || p > 65535) return undefined;
  return p;
}

function sanitizePortForward(rec: PortForwardRecord) {
  return {
    id: rec.id,
    context: rec.context,
    namespace: rec.namespace,
    targetType: rec.targetType,
    targetName: rec.targetName,
    localPort: rec.localPort,
    targetPort: rec.targetPort,
    status: rec.status,
    startedAt: rec.startedAt,
    stoppedAt: rec.stoppedAt,
    pid: rec.pid,
    message: rec.message,
    output: rec.output,
  };
}

function stopPortForwardSession(rec: PortForwardRecord) {
  const p = rec.proc;
  if (!p || p.killed) return;
  try {
    p.kill('SIGTERM');
  } catch {
    // Ignore process kill errors.
  }
  setTimeout(() => {
    try {
      if (!p.killed) p.kill('SIGKILL');
    } catch {
      // Ignore process kill errors.
    }
  }, 1200);
}

// --- Plugin IPC handlers ---

function getPluginsDir(): string {
  return path.join(getConfigDir(), 'plugins');
}

function resolvePluginDir(pluginId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(pluginId)) {
    throw new Error(`Invalid plugin id: ${pluginId}`);
  }
  const pluginsDir = path.resolve(getPluginsDir());
  const pluginDir = path.resolve(pluginsDir, pluginId);
  if (!pluginDir.startsWith(pluginsDir + path.sep)) {
    throw new Error(`Plugin path traversal denied: ${pluginId}`);
  }
  return pluginDir;
}

function assertFileTransferSender(event: Electron.IpcMainInvokeEvent): void {
  if (!trustedFileTransferSenders.has(event.sender.id)) {
    throw new Error('Forbidden IPC sender');
  }
  let url: URL;
  try {
    url = new URL(event.sender.getURL());
  } catch {
    throw new Error('Forbidden IPC sender');
  }
  if (url.searchParams.get('session') !== 'files') {
    throw new Error('Forbidden IPC sender');
  }
}

function getEnabledMapPath(): string {
  return path.join(getPluginsDir(), 'enabled.json');
}

function readEnabledMap(): Record<string, boolean> {
  try {
    return JSON.parse(fs.readFileSync(getEnabledMapPath(), 'utf8')) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeEnabledMap(map: Record<string, boolean>): void {
  const dir = getPluginsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(getEnabledMapPath(), JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// plugin-list: discover plugin directories and return PluginRecord[] compatible objects.
ipcMain.handle('plugin-list', () => {
  const pluginsDir = getPluginsDir();
  const enabledMap = readEnabledMap();
  const records: unknown[] = [];

  try {
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, 'manifest.json');
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const pluginId = manifest.id as string;
        records.push({
          manifest,
          enabled: enabledMap[pluginId] !== false, // enabled by default
          path: pluginDir,
          isBuiltin: false,
        });
      } catch {
        // Skip directories without valid manifests.
      }
    }
  } catch {
    // plugins directory doesn't exist yet — return empty list.
  }

  return records;
});

// plugin-read-file: read a file from within a plugin's directory.
// Path traversal protection: lexical check first, then symlink-resolved check.
ipcMain.handle('plugin-read-file', (_event, pluginId: string, relativePath: string) => {
  const pluginDir = resolvePluginDir(pluginId);
  return readPluginFileUtf8(pluginDir, relativePath);
});

// plugin-storage-get: read a key from a plugin's persistent storage.
ipcMain.handle('plugin-storage-get', (_event, pluginId: string, key: string) => {
  const storagePath = path.join(resolvePluginDir(pluginId), 'storage.json');
  try {
    const data = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as Record<string, unknown>;
    return data[key] ?? null;
  } catch {
    return null;
  }
});

// plugin-storage-set: write a key to a plugin's persistent storage.
ipcMain.handle('plugin-storage-set', (_event, pluginId: string, key: string, value: unknown) => {
  const pluginDir = resolvePluginDir(pluginId);
  const storagePath = path.join(pluginDir, 'storage.json');
  fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as Record<string, unknown>; } catch { /* start fresh */ }
  data[key] = value;
  fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
});

// plugin-storage-delete: remove a key from a plugin's persistent storage.
ipcMain.handle('plugin-storage-delete', (_event, pluginId: string, key: string) => {
  const storagePath = path.join(resolvePluginDir(pluginId), 'storage.json');
  try {
    const data = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as Record<string, unknown>;
    delete data[key];
    fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch { /* nothing to delete */ }
});

// plugin-set-enabled: enable or disable a plugin by id.
ipcMain.handle('plugin-set-enabled', (_event, pluginId: string, enabled: boolean) => {
  const map = readEnabledMap();
  map[pluginId] = enabled;
  writeEnabledMap(map);
});

// open-plugin-directory: open the plugins folder in the system file manager.
ipcMain.handle('open-plugin-directory', async () => {
  const dir = getPluginsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const err = await shell.openPath(dir);
  if (err) console.error('Failed to open plugin directory:', err);
});

// --- Local filesystem IPC (used by FileTransfer component) ---

// List a local directory.
ipcMain.handle('local-fs-list', (event, dirPath: string) => {
  assertFileTransferSender(event);
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.map((e) => {
    const fullPath = path.join(dirPath, e.name);
    let size = 0;
    let modified = '';
    try {
      const st = fs.statSync(fullPath);
      size = st.isFile() ? st.size : 0;
      modified = st.mtime.toISOString();
    } catch { /* ignore stat errors */ }
    return {
      name: e.name,
      isDir: e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(fullPath).isDirectory(); } catch { return false; } })()),
      isLink: e.isSymbolicLink(),
      size,
      modified,
    };
  });
});

// Return the user's home directory.
ipcMain.handle('local-fs-home', (event) => {
  assertFileTransferSender(event);
  return os.homedir();
});

// Save a file to local disk (data as Uint8Array/Buffer from renderer).
ipcMain.handle('local-fs-save', (event, filePath: string, data: Buffer | Uint8Array) => {
  assertFileTransferSender(event);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, Buffer.isBuffer(data) ? data : Buffer.from(data));
});

// Read a local file for upload; returns a Buffer (received as Uint8Array in renderer).
ipcMain.handle('local-fs-read', (event, filePath: string) => {
  assertFileTransferSender(event);
  return fs.readFileSync(filePath);
});

// Create a local directory.
ipcMain.handle('local-fs-mkdir', (event, dirPath: string) => {
  assertFileTransferSender(event);
  fs.mkdirSync(dirPath, { recursive: true });
});

// Open a file-transfer window for a given pod, one window per context:namespace:pod.
ipcMain.handle('open-filetransfer-window', (_event, opts: Record<string, unknown>) => {
  const { context, namespace, pod, container } = opts as {
    context: string; namespace: string; pod: string; container: string;
  };

  const key = `${context}:${namespace}:${pod}`;
  const existing = fileTransferWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { ok: true };
  }

  const win = new BrowserWindow({
    width: 860,
    height: 560,
    title: `${namespace}/${pod} — Files`,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      partition: EPHEMERAL_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installWindowContextMenu(win);

  const params = new URLSearchParams({ session: 'files', context, namespace, pod, container: container || '' });
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${params}`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { search: params.toString() });
  }

  const senderId = win.webContents.id;
  fileTransferWindows.set(key, win);
  trustedFileTransferSenders.add(senderId);
  attachWindowShortcuts(win);
  win.on('closed', () => {
    fileTransferWindows.delete(key);
    trustedFileTransferSenders.delete(senderId);
  });
  win.webContents.on('did-finish-load', () => sendThemeUpdate(win));
  return { ok: true };
});

// Append log/session output into a coherent per-day/per-context file.
ipcMain.handle(
  'session-log-append',
  (_event, meta: { kind: 'logs' | 'exec'; context: string; namespace: string; pod: string; container: string }, chunk: string) => {
    if (!chunk) return { ok: true };
    const filePath = sessionLogPath(meta);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, chunk, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, path: filePath };
  },
);

ipcMain.handle(
  'session-log-path',
  (_event, meta: { kind: 'logs' | 'exec'; context: string; namespace: string; pod: string; container: string }) => {
    const filePath = sessionLogPath(meta);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    return filePath;
  },
);

ipcMain.handle(
  'session-log-save-as',
  async (
    _event,
    meta: { kind: 'logs' | 'exec'; context: string; namespace: string; pod: string; container: string },
    content: string,
  ) => {
    const defaultPath = sessionLogPath(meta);
    const result = await dialog.showSaveDialog({
      title: 'Save Session Log',
      defaultPath,
      filters: [
        { name: 'Log Files', extensions: ['log', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    fs.mkdirSync(path.dirname(result.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(result.filePath, content ?? '', { encoding: 'utf8', mode: 0o600 });
    return { canceled: false, path: result.filePath };
  },
);

ipcMain.handle('clipboard-write-text', (_event, text: string) => {
  clipboard.writeText(text ?? '');
  return { ok: true };
});

ipcMain.handle('clipboard-read-text', () => clipboard.readText());

// Open YAML content in the system default editor using a temp file.
ipcMain.handle(
  'yaml-open-external-editor',
  async (
    _event,
    opts: {
      context: string;
      namespace: string;
      resource: string;
      name: string;
      yaml: string;
    },
  ) => {
    const safeContext = sanitizeFilenamePart(opts?.context || 'context');
    const safeNs = sanitizeFilenamePart(opts?.namespace || 'cluster');
    const safeRes = sanitizeFilenamePart(opts?.resource || 'resource');
    const safeName = sanitizeFilenamePart(opts?.name || 'name');
    const stamp = timestampForFilename(new Date());

    const dir = getExternalYamlDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, `${safeContext}--${safeNs}--${safeRes}--${safeName}--${stamp}.yaml`);
    fs.writeFileSync(filePath, opts?.yaml ?? '', { encoding: 'utf8', mode: 0o600 });

    const openErr = await shell.openPath(filePath);
    if (openErr) {
      throw new Error(`Failed to open external editor: ${openErr}`);
    }
    return { filePath };
  },
);

ipcMain.handle('yaml-read-external-editor-file', (_event, filePath: string) => {
  const safePath = assertExternalYamlPath(filePath);
  return fs.readFileSync(safePath, 'utf8');
});

ipcMain.handle('yaml-cleanup-external-editor-file', (_event, filePath: string) => {
  try {
    const safePath = assertExternalYamlPath(filePath);
    if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
  } catch {
    // Ignore cleanup failures.
  }
  return { ok: true };
});

ipcMain.handle(
  'open-yaml-diff-window',
  async (
    _event,
    payload: {
      context: string;
      namespace: string;
      resource: string;
      name: string;
      currentYaml: string;
      proposedYaml: string;
    },
  ) => {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    yamlDiffPayloads.set(token, {
      context: payload.context || '',
      namespace: payload.namespace || '',
      resource: payload.resource || '',
      name: payload.name || '',
      currentYaml: payload.currentYaml ?? '',
      proposedYaml: payload.proposedYaml ?? '',
    });

    const win = new BrowserWindow({
      width: 1200,
      height: 760,
      title: `${payload.namespace}/${payload.name} — YAML Diff`,
      icon: getIconPath(),
      parent: mainWindow ?? undefined,
      modal: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        partition: EPHEMERAL_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    installWindowContextMenu(win);
    attachWindowShortcuts(win);
    const params = new URLSearchParams({ session: 'yaml-diff', token });
    if (process.env.VITE_DEV_SERVER_URL) {
      await win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${params}`);
    } else {
      await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { search: params.toString() });
    }
    win.webContents.on('did-finish-load', () => sendThemeUpdate(win));

    const decision = await new Promise<boolean>((resolve) => {
      yamlDiffPending.set(token, { window: win, resolve });
      win.on('closed', () => {
        const pending = yamlDiffPending.get(token);
        if (pending) {
          yamlDiffPending.delete(token);
          pending.resolve(false);
        }
        yamlDiffPayloads.delete(token);
      });
    });
    return { approved: decision };
  },
);

ipcMain.handle('get-yaml-diff-payload', (_event, token: string) => {
  const payload = yamlDiffPayloads.get(token);
  if (!payload) {
    throw new Error('YAML diff payload not found');
  }
  return payload;
});

ipcMain.handle('submit-yaml-diff-decision', (_event, token: string, approved: boolean) => {
  const pending = yamlDiffPending.get(token);
  if (!pending) return { ok: false };
  yamlDiffPending.delete(token);
  yamlDiffPayloads.delete(token);
  pending.resolve(!!approved);
  if (!pending.window.isDestroyed()) {
    pending.window.close();
  }
  return { ok: true };
});

app.whenReady().then(async () => {
  if (!singleInstanceLock) return;
  // Keep crash reports local-only; disable Crashpad uploads.
  crashReporter.start({
    uploadToServer: false,
    submitURL: '',
    compress: true,
  });
  wipeTransientUserDataDirs();
  await wipeTransientSessionData();

  ensureUserCssTemplate();
  loadPreferences();
  applyThemeMode(preferences.themeMode, undefined, false);
  nativeTheme.on('updated', () => {
    if (preferences.themeMode === 'system' || preferences.themeMode === 'user-css') {
      broadcastThemeUpdate();
    }
  });

  try {
    console.log('Starting trussd daemon...');
    daemonConfig = await startDaemon({ pathHints: preferences.execPathHints });
    console.log(`Daemon running on port ${daemonConfig.port}`);
  } catch (err) {
    console.error('Failed to start daemon:', err);
  }

  await createWindow();

  if (mainWindow) {
    mainWindow.on('close', (event) => {
      if (forceAppQuit) return;
      event.preventDefault();
      const openSubapps =
        (logsWindow && !logsWindow.isDestroyed() ? 1 : 0) +
        Array.from(execWindows.values()).filter((w) => !w.isDestroyed()).length +
        Array.from(fileTransferWindows.values()).filter((w) => !w.isDestroyed()).length +
        (portForwardWindow && !portForwardWindow.isDestroyed() ? 1 : 0);
      const detail = openSubapps > 0
        ? `${openSubapps} active session window${openSubapps === 1 ? '' : 's'} will also be closed.`
        : 'The daemon and all active sessions will be stopped.';
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: 'warning',
        buttons: ['Cancel', 'Quit'],
        defaultId: 1,
        cancelId: 0,
        title: 'Quit Truss',
        message: 'Quit Truss?',
        detail,
      });
      if (choice === 1) {
        forceAppQuit = true;
        app.quit();
      }
    });
  }
});

app.on('window-all-closed', () => {
  // Only quit when all windows (including session windows) are closed.
  stopDaemon();
  app.quit();
});

app.on('before-quit', () => {
  if (logsWindow && !logsWindow.isDestroyed()) logsWindow.close();
  logsWindow = null;
  for (const win of execWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  execWindows.clear();
  for (const win of fileTransferWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  fileTransferWindows.clear();
  if (portForwardWindow && !portForwardWindow.isDestroyed()) {
    portForwardWindow.close();
  }
  portForwardWindow = null;
  for (const pf of portForwards.values()) {
    stopPortForwardSession(pf);
  }
  portForwards.clear();
  trustedFileTransferSenders.clear();
  wipeTransientUserDataDirs();
  void wipeTransientSessionData();
  stopDaemon();
});
