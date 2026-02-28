import { useMemo } from 'react';
import type { PluginResource, HealthCategory } from './types';
import { pluginRegistry } from './registry';

// Returns a stable classify function that chains all registered health classifiers.
// The first classifier to return a non-null value wins.
export function useClassifyHealth(): (resource: PluginResource) => HealthCategory {
  return useMemo(
    () =>
      (resource: PluginResource): HealthCategory => {
        for (const classifier of pluginRegistry.healthClassifiers) {
          const result = classifier.classify(resource);
          if (result !== null) return result;
        }
        return 'ok';
      },
    [],
  );
}

// Returns the list of inspector tabs registered for the given resource.
export function useInspectorTabs(resource: PluginResource | null) {
  return useMemo(() => {
    if (!resource) return [];
    return pluginRegistry.inspectorTabs.filter((tab) => {
      if (tab.kinds && !tab.kinds.includes(resource.kind)) return false;
      if (tab.isAvailable && !tab.isAvailable(resource)) return false;
      return true;
    });
  }, [resource]);
}

// Returns the list of context menu items applicable to the given resource.
export function useContextMenuItems(resource: PluginResource | null) {
  return useMemo(() => {
    if (!resource) return [];
    return pluginRegistry.contextMenuItems.filter((item) => {
      if (item.kinds && !item.kinds.includes(resource.kind)) return false;
      if (item.isAvailable && !item.isAvailable(resource)) return false;
      return true;
    });
  }, [resource]);
}

// Returns the list of action buttons applicable to the given resource.
export function useActionButtons(resource: PluginResource | null) {
  return useMemo(() => {
    if (!resource) return [];
    return pluginRegistry.actionButtons.filter((btn) => {
      if (btn.kinds && !btn.kinds.includes(resource.kind)) return false;
      if (btn.isAvailable && !btn.isAvailable(resource)) return false;
      return true;
    });
  }, [resource]);
}

// Returns plugin columns applicable to the given GVR key ("group/version/resource").
export function useResourceColumns(gvrKey: string) {
  return useMemo(
    () => pluginRegistry.resourceColumns.filter((col) => !col.gvrKeys || col.gvrKeys.includes(gvrKey)),
    [gvrKey],
  );
}

// Returns all registered tree sections sorted by order.
export function useTreeSections() {
  return useMemo(() => pluginRegistry.treeSections, []);
}

// Returns all registered theme extensions in registration order.
export function useThemeExtensions() {
  return useMemo(() => pluginRegistry.themeExtensions, []);
}
