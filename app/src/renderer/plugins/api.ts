import { useAppStore } from '../state/store';
import { fetchSetupAPI, getYamlClient } from '../api/client';
import { GVR } from '../api/gen/truss/v1/resources_pb';
import type { PluginAPI } from './types';

export function createPluginAPI(pluginId: string): PluginAPI {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI?.openSessionWindow({ kind: 'exec', context, namespace, pod, container });
    },

    openLogsWindow({ context, namespace, pod, container }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI?.openSessionWindow({ kind: 'logs', context, namespace, pod, container });
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (window as any).electronAPI?.pluginStorageGet?.(pluginId, key) ?? null;
      },
      async set(key, value) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (window as any).electronAPI?.pluginStorageSet?.(pluginId, key, value);
      },
      async remove(key) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (window as any).electronAPI?.pluginStorageDelete?.(pluginId, key);
      },
      secure: {
        async get<T>(key: string): Promise<T | null> {
          const resp = await fetchSetupAPI('/api/plugins/secure-storage/get', {
            method: 'POST',
            body: JSON.stringify({ plugin_id: pluginId, key }),
          });
          if (!resp.ok) return null;
          const data = await resp.json().catch(() => ({}));
          return ((data as { value?: T | null }).value ?? null) as T | null;
        },
        async set(key: string, value: unknown) {
          const resp = await fetchSetupAPI('/api/plugins/secure-storage/set', {
            method: 'POST',
            body: JSON.stringify({ plugin_id: pluginId, key, value }),
          });
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error((data as { error?: string }).error || 'Failed to store secure value');
          }
        },
        async remove(key: string) {
          const resp = await fetchSetupAPI('/api/plugins/secure-storage/delete', {
            method: 'POST',
            body: JSON.stringify({ plugin_id: pluginId, key }),
          });
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error((data as { error?: string }).error || 'Failed to delete secure value');
          }
        },
      },
    },
  };
}
