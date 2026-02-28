import type { PluginRecord, PluginModule } from './types';
import { pluginRegistry } from './registry';
import { createPluginAPI } from './api';

export type LoadedPlugin = PluginRecord & { unload(): void };

const loadedPlugins = new Map<string, LoadedPlugin>();

// Fetch all discovered plugin records from the main process.
export async function discoverPlugins(): Promise<PluginRecord[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (window as any).electronAPI?.pluginList?.() ?? [];
  } catch {
    return [];
  }
}

// Dynamically load and register an external plugin using the Blob URL trick.
// The plugin bundle is read from disk via IPC, wrapped in a Blob URL, and
// imported as a dynamic ES module. This works in Electron's renderer context.
export async function loadPlugin(record: PluginRecord): Promise<void> {
  const pluginId = record.manifest.id;
  if (loadedPlugins.has(pluginId)) return;

  // Fetch plugin source from the main process.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const code: string = await (window as any).electronAPI.pluginReadFile(pluginId, record.manifest.entry);

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

    const api = createPluginAPI(pluginId);
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
    URL.revokeObjectURL(url);
    throw err;
  }
}

export function unloadPlugin(pluginId: string): void {
  loadedPlugins.get(pluginId)?.unload();
}

export function getLoadedPlugins(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values());
}
