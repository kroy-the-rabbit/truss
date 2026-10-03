import type { PluginRecord, PluginModule } from './types';
import { pluginRegistry } from './registry';
import { createPluginAPI } from './api';

export type LoadedPlugin = PluginRecord & { unload(): void };

interface PluginLoadResult {
  pluginId: string;
  code?: string;
  capability?: string | null;
  error?: string;
}

interface PluginBridge {
  pluginList?(): Promise<PluginRecord[]>;
  pluginLoad?(pluginIds: string[]): Promise<PluginLoadResult[]>;
  pluginSetApproval?(pluginId: string, approve: boolean): Promise<{
    approved: boolean;
    cancelled?: boolean;
    code?: string | null;
    capability?: string | null;
  }>;
}

const loadedPlugins = new Map<string, LoadedPlugin>();
// Storage capabilities minted by main, one per plugin. Module-private: never
// exported, never put in React state, only captured by each plugin's API.
const capabilities = new Map<string, string>();

function bridge(): PluginBridge {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((window as any).electronAPI ?? {}) as PluginBridge;
}

// Fetch all discovered plugin records from the main process.
export async function discoverPlugins(): Promise<PluginRecord[]> {
  try {
    return (await bridge().pluginList?.()) ?? [];
  } catch {
    return [];
  }
}

// Third-party plugins load only when main reports them approved and unchanged.
export function isLoadable(record: PluginRecord): boolean {
  if (record.isBuiltin) return false; // built-ins are registered statically
  return record.enabled === true && record.consent === 'approved' && !record.loadError;
}

// Import a plugin's code via a Blob URL and run its register().
async function importAndRegister(record: PluginRecord, code: string): Promise<void> {
  const pluginId = record.manifest.id;
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);

  try {
    // Vite-ignore suppresses the static analysis warning on the dynamic URL.
    const mod = await import(/* @vite-ignore */ url) as {
      default?: PluginModule;
      register?: PluginModule['register'];
    };

    const registerFn = mod.default?.register ?? mod.register;
    if (typeof registerFn !== 'function') {
      throw new Error(`Plugin "${pluginId}" has no register() export`);
    }

    const api = createPluginAPI(pluginId, capabilities.get(pluginId) ?? null);
    pluginRegistry.setApi(pluginId, api);
    const registrar = pluginRegistry.createRegistrar(pluginId);
    await registerFn(api, registrar);

    loadedPlugins.set(pluginId, {
      ...record,
      unload() {
        pluginRegistry.unregisterPlugin(pluginId);
        URL.revokeObjectURL(url);
        loadedPlugins.delete(pluginId);
      },
    });
  } catch (err) {
    pluginRegistry.unregisterPlugin(pluginId);
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * Load every approved plugin in `records`. Code and storage capabilities for
 * all of them are fetched from main in ONE call before any plugin code runs,
 * so no plugin can claim another plugin's capability first. Returns the
 * records annotated with load errors; unapproved plugins are skipped.
 */
export async function loadPlugins(records: PluginRecord[]): Promise<PluginRecord[]> {
  const toLoad = records.filter((r) => isLoadable(r) && !loadedPlugins.has(r.manifest.id));
  const results = new Map<string, PluginLoadResult>();
  if (toLoad.length > 0) {
    const loadFn = bridge().pluginLoad;
    if (!loadFn) throw new Error('Plugin loading is unavailable');
    for (const res of await loadFn(toLoad.map((r) => r.manifest.id))) {
      results.set(res.pluginId, res);
      if (res.capability) capabilities.set(res.pluginId, res.capability);
    }
  }

  const out: PluginRecord[] = [];
  for (const record of records) {
    if (!toLoad.includes(record)) {
      out.push(record);
      continue;
    }
    const res = results.get(record.manifest.id);
    if (!res || res.error || typeof res.code !== 'string') {
      out.push({ ...record, enabled: false, loadError: res?.error ?? 'Plugin was not returned by main' });
      continue;
    }
    try {
      await importAndRegister(record, res.code);
      out.push(record);
    } catch (err) {
      out.push({ ...record, loadError: String(err) });
    }
  }
  return out;
}

// Single-plugin convenience wrapper kept for callers of the old API.
export async function loadPlugin(record: PluginRecord): Promise<void> {
  const [res] = await loadPlugins([record]);
  if (res?.loadError) throw new Error(res.loadError);
}

/**
 * Ask main to approve a plugin (main shows a native confirmation dialog) and,
 * if confirmed, load it with the capability main returns. The capability never
 * leaves this module.
 */
export async function approvePlugin(record: PluginRecord): Promise<boolean> {
  const fn = bridge().pluginSetApproval;
  if (!fn) return false;
  const pluginId = record.manifest.id;
  const res = await fn(pluginId, true);
  if (!res?.approved) return false;
  // Main revoked any earlier capability; drop the old instance.
  unloadPlugin(pluginId);
  if (res.capability) capabilities.set(pluginId, res.capability);
  if (typeof res.code === 'string') {
    await importAndRegister({ ...record, enabled: true, consent: 'approved', needsConsent: false }, res.code);
  }
  return true;
}

/** Record "keep disabled" (or revoke) and unload the plugin if it is running. */
export async function denyPlugin(pluginId: string): Promise<void> {
  const fn = bridge().pluginSetApproval;
  if (fn) await fn(pluginId, false);
  unloadPlugin(pluginId);
}

export function unloadPlugin(pluginId: string): void {
  loadedPlugins.get(pluginId)?.unload();
  capabilities.delete(pluginId);
}

export function getLoadedPlugins(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values());
}
