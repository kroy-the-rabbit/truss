// Public plugin SDK exports

export type {
  HealthCategory,
  PluginResource,
  PluginCapability,
  PluginManifest,
  PluginRecord,
  HealthClassifierExtension,
  InspectorTabExtension,
  InspectorTabProps,
  ResourceColumnExtension,
  ContextMenuItemExtension,
  ActionButtonExtension,
  TreeSectionExtension,
  TreeSectionProps,
  ThemeExtension,
  PluginRegistrar,
  PluginAPI,
  PluginModule,
} from './types';

export { pluginRegistry } from './registry';
export { PluginProvider, usePluginContext } from './context';
export { PluginManager } from './PluginManager';

export {
  useClassifyHealth,
  useInspectorTabs,
  useContextMenuItems,
  useActionButtons,
  useResourceColumns,
  useTreeSections,
  useThemeExtensions,
} from './hooks';

export { toPluginResource } from './adapter';
export { createPluginAPI } from './api';
