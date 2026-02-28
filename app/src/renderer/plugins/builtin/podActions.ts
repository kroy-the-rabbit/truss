import type { PluginRegistrar } from '../types';

// Registers Logs, Exec, and Files context menu items for Pod resources.
export function registerPodActions(registrar: PluginRegistrar): void {
  registrar.registerContextMenuItem({
    id: 'builtin.pod.logs',
    label: 'Logs',
    kinds: ['Pod'],
    onClick(resource, api) {
      api.openLogsWindow({
        context: api.getActiveContext(),
        namespace: resource.namespace || api.getActiveNamespace(),
        pod: resource.name,
        container: '',
      });
    },
  });

  registrar.registerContextMenuItem({
    id: 'builtin.pod.exec',
    label: 'Exec',
    kinds: ['Pod'],
    onClick(resource, api) {
      api.openExecWindow({
        context: api.getActiveContext(),
        namespace: resource.namespace || api.getActiveNamespace(),
        pod: resource.name,
        container: '',
      });
    },
  });

  registrar.registerContextMenuItem({
    id: 'builtin.pod.files',
    label: 'Files',
    kinds: ['Pod'],
    onClick(resource, api) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI?.openFileTransferWindow?.({
        context: api.getActiveContext(),
        namespace: resource.namespace || api.getActiveNamespace(),
        pod: resource.name,
        container: '',
      });
    },
  });
}
