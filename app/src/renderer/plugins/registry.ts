import type {
  HealthClassifierExtension,
  InspectorTabExtension,
  ResourceColumnExtension,
  ContextMenuItemExtension,
  ActionButtonExtension,
  TreeSectionExtension,
  ThemeExtension,
  PluginRegistrar,
} from './types';

type Tagged<T> = T & { _pluginId: string };

class PluginRegistry {
  private _healthClassifiers: Tagged<HealthClassifierExtension>[] = [];
  private _inspectorTabs: Tagged<InspectorTabExtension>[] = [];
  private _resourceColumns: Tagged<ResourceColumnExtension>[] = [];
  private _contextMenuItems: Tagged<ContextMenuItemExtension>[] = [];
  private _actionButtons: Tagged<ActionButtonExtension>[] = [];
  private _treeSections: Tagged<TreeSectionExtension>[] = [];
  private _themeExtensions: Tagged<ThemeExtension>[] = [];

  createRegistrar(pluginId: string): PluginRegistrar {
    return {
      registerHealthClassifier: (ext) =>
        this._healthClassifiers.push({ ...ext, _pluginId: pluginId }),
      registerInspectorTab: (ext) =>
        this._inspectorTabs.push({ ...ext, _pluginId: pluginId }),
      registerResourceColumn: (ext) =>
        this._resourceColumns.push({ ...ext, _pluginId: pluginId }),
      registerContextMenuItem: (ext) =>
        this._contextMenuItems.push({ ...ext, _pluginId: pluginId }),
      registerActionButton: (ext) =>
        this._actionButtons.push({ ...ext, _pluginId: pluginId }),
      registerTreeSection: (ext) =>
        this._treeSections.push({ ...ext, _pluginId: pluginId }),
      registerTheme: (ext) =>
        this._themeExtensions.push({ ...ext, _pluginId: pluginId }),
    };
  }

  unregisterPlugin(pluginId: string): void {
    const keep = <T extends { _pluginId: string }>(arr: T[]) =>
      arr.filter((e) => e._pluginId !== pluginId);
    this._healthClassifiers = keep(this._healthClassifiers);
    this._inspectorTabs = keep(this._inspectorTabs);
    this._resourceColumns = keep(this._resourceColumns);
    this._contextMenuItems = keep(this._contextMenuItems);
    this._actionButtons = keep(this._actionButtons);
    this._treeSections = keep(this._treeSections);
    this._themeExtensions = keep(this._themeExtensions);
  }

  // Sorted by priority descending — higher priority runs first.
  get healthClassifiers(): Tagged<HealthClassifierExtension>[] {
    return [...this._healthClassifiers].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  get inspectorTabs(): Tagged<InspectorTabExtension>[] {
    return this._inspectorTabs;
  }

  get resourceColumns(): Tagged<ResourceColumnExtension>[] {
    return this._resourceColumns;
  }

  get contextMenuItems(): Tagged<ContextMenuItemExtension>[] {
    return this._contextMenuItems;
  }

  get actionButtons(): Tagged<ActionButtonExtension>[] {
    return this._actionButtons;
  }

  // Sorted by order ascending — lower order renders first.
  get treeSections(): Tagged<TreeSectionExtension>[] {
    return [...this._treeSections].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  // Theme extensions in registration order.
  get themeExtensions(): Tagged<ThemeExtension>[] {
    return this._themeExtensions;
  }
}

export const pluginRegistry = new PluginRegistry();
