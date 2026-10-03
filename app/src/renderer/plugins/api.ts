import { useAppStore } from '../state/store';
import { getYamlClient } from '../api/client';
import { GVR } from '../api/gen/truss/v1/resources_pb';
import type { PluginAPI } from './types';

interface PluginStorageBridge {
  pluginStorageGet?(capability: string, key: string): Promise<unknown>;
  pluginStorageSet?(capability: string, key: string, value: unknown): Promise<void>;
  pluginStorageDelete?(capability: string, key: string): Promise<void>;
  pluginSecureStorage?(capability: string, op: 'get' | 'set' | 'delete', key: string, value?: unknown): Promise<unknown>;
  openSessionWindow?(opts: Record<string, string>): void;
}

function bridge(): PluginStorageBridge {
  // contextBridge-exposed objects are frozen and the window property is
  // read-only, so plugin code cannot swap these out to intercept another
  // plugin's capability.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((window as any).electronAPI ?? {}) as PluginStorageBridge;
}

/**
 * Build the API object handed to one plugin. `capability` is the opaque
 * storage token main minted for this plugin; it lives only in this closure and
 * main derives the plugin id from it, so a plugin cannot read or write another
 * plugin's storage. The API deliberately exposes no daemon token, clipboard or
 * terminal access (same-renderer plugin code can still reach window.electronAPI
 * directly; consent is the control for that).
 */
export function createPluginAPI(pluginId: string, capability: string | null = null): PluginAPI {
  const requireCapability = (): string => {
    if (!capability) throw new Error(`Storage is not available to plugin "${pluginId}"`);
    return capability;
  };

  return {
    pluginId,

    getActiveContext() {
      return useAppStore.getState().activeContext;
    },

    getActiveNamespace() {
      return useAppStore.getState().activeNamespace;
    },

    getSelectedResource() {
      return useAppStore.getState().selectedResource || null;
    },

    selectResource(name, namespace) {
      useAppStore.getState().setSelectedResource(name, namespace);
    },

    setActivePane(pane) {
      useAppStore.getState().setActivePane(pane);
    },

    openExecWindow({ context, namespace, pod, container }) {
      bridge().openSessionWindow?.({ kind: 'exec', context, namespace, pod, container });
    },

    openLogsWindow({ context, namespace, pod, container }) {
      bridge().openSessionWindow?.({ kind: 'logs', context, namespace, pod, container });
    },

    async fetchResourceYaml({ context, namespace, gvr, name }) {
      const client = await getYamlClient();
      const gvrObj = new GVR({ group: gvr.group, version: gvr.version, resource: gvr.resource });
      const resp = await client.getYaml({ context, namespace, gvr: gvrObj, name });
      return resp.yaml;
    },

    async applyYaml({ context, namespace, yaml }) {
      if (useAppStore.getState().readOnly) {
        throw new Error('Write mode is disabled (read-only mode is enabled)');
      }
      const client = await getYamlClient();
      const resp = await client.applyYaml({ context, namespace, yaml });
      return { message: resp.message };
    },

    storage: {
      async get<T>(key: string): Promise<T | null> {
        const cap = requireCapability();
        return ((await bridge().pluginStorageGet?.(cap, key)) ?? null) as T | null;
      },
      async set(key, value) {
        await bridge().pluginStorageSet?.(requireCapability(), key, value);
      },
      async remove(key) {
        await bridge().pluginStorageDelete?.(requireCapability(), key);
      },
      // Secure storage goes through main (never straight to trussd): main
      // injects the bound plugin id and the main-only storage secret.
      secure: {
        async get<T>(key: string): Promise<T | null> {
          const cap = requireCapability();
          return ((await bridge().pluginSecureStorage?.(cap, 'get', key)) ?? null) as T | null;
        },
        async set(key: string, value: unknown) {
          await bridge().pluginSecureStorage?.(requireCapability(), 'set', key, value);
        },
        async remove(key: string) {
          await bridge().pluginSecureStorage?.(requireCapability(), 'delete', key);
        },
      },
    },
  };
}
