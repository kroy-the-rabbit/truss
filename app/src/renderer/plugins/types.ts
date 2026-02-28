import type React from 'react';

// Health category returned by classifiers.
export type HealthCategory = 'ok' | 'warn' | 'err';

// Simplified, plain-object resource representation for plugins.
// Converts from the proto-generated Resource class via toPluginResource().
export interface PluginResource {
  name: string;
  namespace: string;
  kind: string;
  apiVersion: string;
  gvr: { group: string; version: string; resource: string };
  summary: Array<{ key: string; value: string }>;
  conditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
  metadata: {
    uid: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    creationTimestamp: string;
  };
}

export type PluginCapability =
  | 'health-classifier'
  | 'inspector-tab'
  | 'resource-column'
  | 'context-menu-item'
  | 'action-button'
  | 'tree-section'
  | 'theme';

// The manifest.json file each plugin ships.
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: '1';
  description?: string;
  author?: string;
  homepage?: string;
  capabilities: PluginCapability[];
  entry: string; // relative path to the JS bundle
}

// A record of a discovered plugin (from disk or built-in).
export interface PluginRecord {
  manifest: PluginManifest;
  enabled: boolean;
  path: string;      // absolute path to plugin directory ('' for built-ins)
  isBuiltin?: boolean;
  loadError?: string;
}

// --- Extension point interfaces ---

export interface HealthClassifierExtension {
  id: string;
  // Higher priority classifiers run first. Built-in defaults to 0.
  // Override with positive priority values (e.g. 10).
  priority?: number;
  classify(resource: PluginResource): HealthCategory | null;
}

export interface InspectorTabProps {
  resource: PluginResource;
  context: string;
  namespace: string;
  api: PluginAPI;
}

export interface InspectorTabExtension {
  id: string;
  label: string;
  // If specified, only show for these resource kinds.
  kinds?: string[];
  isAvailable?(resource: PluginResource): boolean;
  render(props: InspectorTabProps): React.ReactNode;
}

export interface ResourceColumnExtension {
  id: string;
  label: string;
  width?: number;
  // If specified, only show for these GVR keys ("group/version/resource").
  gvrKeys?: string[];
  getValue(resource: PluginResource): string;
  renderCell?(value: string, resource: PluginResource, api: PluginAPI): React.ReactNode;
  sortable?: boolean;
}

export interface ContextMenuItemExtension {
  id: string;
  label: string;
  kinds?: string[];
  isAvailable?(resource: PluginResource): boolean;
  isDanger?: boolean;
  onClick(resource: PluginResource, api: PluginAPI): void;
}

export interface ActionButtonExtension {
  id: string;
  label: string;
  title?: string;
  kinds?: string[];
  isDanger?: boolean;
  isAvailable?(resource: PluginResource): boolean;
  onClick(resource: PluginResource, api: PluginAPI): void;
}

export interface TreeSectionProps {
  api: PluginAPI;
}

export interface TreeSectionExtension {
  id: string;
  label: string;
  // Lower order renders first. Built-in Helm section defaults to 100.
  order?: number;
  render(props: TreeSectionProps): React.ReactNode;
}

export interface ThemeExtension {
  id: string;
  label: string;
  // Whether this theme is light or dark — used to hint the OS for native
  // decorations (titlebar, system dialogs). Defaults to 'dark'.
  tone?: 'light' | 'dark';
  // Returns a CSS string injected as a <style> element.
  // Should target :root and define all --variable overrides.
  getCss(): string;
}

// --- Registrar (what plugin register() calls) ---

export interface PluginRegistrar {
  registerHealthClassifier(ext: HealthClassifierExtension): void;
  registerInspectorTab(ext: InspectorTabExtension): void;
  registerResourceColumn(ext: ResourceColumnExtension): void;
  registerContextMenuItem(ext: ContextMenuItemExtension): void;
  registerActionButton(ext: ActionButtonExtension): void;
  registerTreeSection(ext: TreeSectionExtension): void;
  registerTheme(ext: ThemeExtension): void;
}

// --- Plugin API (what plugins call to interact with the app) ---

export interface PluginAPI {
  pluginId: string;

  // App state access
  getActiveContext(): string;
  getActiveNamespace(): string;
  getSelectedResource(): string | null;

  // Navigation
  selectResource(name: string, namespace?: string): void;
  setActivePane(pane: 'navigator' | 'list' | 'inspector'): void;

  // Window actions
  openExecWindow(opts: { context: string; namespace: string; pod: string; container: string }): void;
  openLogsWindow(opts: { context: string; namespace: string; pod: string; container: string }): void;

  // K8s operations
  fetchResourceYaml(opts: {
    context: string;
    namespace: string;
    gvr: { group: string; version: string; resource: string };
    name: string;
  }): Promise<string>;

  applyYaml(opts: { context: string; namespace: string; yaml: string }): Promise<{ message: string }>;

  // Per-plugin persistent storage (key-value, JSON-serializable values)
  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    secure: {
      get<T = unknown>(key: string): Promise<T | null>;
      set(key: string, value: unknown): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
}

// --- External plugin module contract ---

// External plugin bundles must export either:
//   export function register(api, registrar) { ... }
// or:
//   export default { register(api, registrar) { ... } }
export interface PluginModule {
  register(api: PluginAPI, registrar: PluginRegistrar): void | Promise<void>;
}
