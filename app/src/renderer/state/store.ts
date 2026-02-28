import { create } from 'zustand';
import type { GVR } from '../api/gen/truss/v1/resources_pb';
import type { NavSnapshot } from './navCheckpoint';

interface ContextNavState {
  namespace: string;
  kind: GVR | null;
  kindLabel: string;
  resource: string;
  resourceNamespace: string;
}

interface NamespaceNavState {
  kind: GVR | null;
  kindLabel: string;
  resource: string;
  resourceNamespace: string;
}

interface AppState {
  activeProfile: string;
  activeContext: string;
  activeNamespace: string;
  selectedKind: GVR | null;
  selectedKindLabel: string;
  selectedResource: string;
  selectedResourceNamespace: string;
  readOnly: boolean;
  themeMode: string;
  autoLockMinutes: number;
  neverConfirmStartupBypass: boolean;
  effectiveTheme: 'light' | 'dark';
  userCss: string;
  userCssPath: string;
  eventSuppressionRules: string[];
  activePane: 'navigator' | 'list' | 'inspector';
  connected: boolean;
  liveUpdatesConnected: boolean;
  contextNavCache: Map<string, ContextNavState>;
  namespaceNavCache: Map<string, NamespaceNavState>;

  setActiveProfile: (profile: string) => void;
  setActiveContext: (ctx: string) => void;
  setActiveNamespace: (ns: string) => void;
  setSelectedKind: (gvr: GVR | null, label: string) => void;
  setSelectedResource: (name: string, namespace?: string) => void;
  setReadOnly: (v: boolean) => void;
  setThemeMode: (mode: string) => void;
  setAutoLockMinutes: (minutes: number) => void;
  setNeverConfirmStartupBypass: (bypass: boolean) => void;
  setEffectiveTheme: (theme: 'light' | 'dark') => void;
  setUserCss: (css: string) => void;
  setUserCssPath: (path: string) => void;
  setEventSuppressionRules: (rules: string[]) => void;
  setActivePane: (pane: 'navigator' | 'list' | 'inspector') => void;
  setConnected: (connected: boolean) => void;
  setLiveUpdatesConnected: (connected: boolean) => void;
  // Atomically restore navigation state after an unlock cycle.
  restoreNav: (nav: NavSnapshot) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeProfile: 'default',
  activeContext: '',
  activeNamespace: '',
  selectedKind: null,
  selectedKindLabel: '',
  selectedResource: '',
  selectedResourceNamespace: '',
  readOnly: true,
  themeMode: 'system',
  autoLockMinutes: 20,
  neverConfirmStartupBypass: false,
  effectiveTheme: 'dark',
  userCss: '',
  userCssPath: '',
  eventSuppressionRules: [],
  activePane: 'navigator',
  connected: false,
  liveUpdatesConnected: false,
  contextNavCache: new Map(),
  namespaceNavCache: new Map(),

  setActiveProfile: (profile) => set({ activeProfile: profile }),
  setActiveContext: (ctx) =>
    set((state) => {
      const oldCtx = state.activeContext;
      const cache = new Map(state.contextNavCache);
      if (oldCtx) {
        cache.set(oldCtx, {
          namespace: state.activeNamespace,
          kind: state.selectedKind,
          kindLabel: state.selectedKindLabel,
          resource: state.selectedResource,
          resourceNamespace: state.selectedResourceNamespace,
        });
      }
      const restored = cache.get(ctx);
      return {
        activeContext: ctx,
        contextNavCache: cache,
        activeNamespace: restored?.namespace ?? '',
        selectedKind: restored?.kind ?? null,
        selectedKindLabel: restored?.kindLabel ?? '',
        selectedResource: restored?.resource ?? '',
        selectedResourceNamespace: restored?.resourceNamespace ?? '',
      };
    }),
  setActiveNamespace: (ns) =>
    set((state) => {
      const oldKey = `${state.activeContext}::${state.activeNamespace}`;
      const newKey = `${state.activeContext}::${ns}`;
      const cache = new Map(state.namespaceNavCache);
      if (state.activeNamespace) {
        cache.set(oldKey, {
          kind: state.selectedKind,
          kindLabel: state.selectedKindLabel,
          resource: state.selectedResource,
          resourceNamespace: state.selectedResourceNamespace,
        });
      }
      const restored = cache.get(newKey);
      return {
        activeNamespace: ns,
        namespaceNavCache: cache,
        selectedKind: restored?.kind ?? state.selectedKind,
        selectedKindLabel: restored?.kindLabel ?? state.selectedKindLabel,
        selectedResource: restored?.resource ?? '',
        selectedResourceNamespace: restored?.resourceNamespace ?? '',
      };
    }),
  setSelectedKind: (gvr, label) => set({ selectedKind: gvr, selectedKindLabel: label, selectedResource: '', selectedResourceNamespace: '' }),
  setSelectedResource: (name, namespace) => set({ selectedResource: name, selectedResourceNamespace: namespace ?? '' }),
  setReadOnly: (v) => set({ readOnly: v }),
  setThemeMode: (mode) => set({ themeMode: mode }),
  setAutoLockMinutes: (minutes) => set({ autoLockMinutes: Math.max(0, Math.floor(minutes || 0)) }),
  setNeverConfirmStartupBypass: (bypass) => set({ neverConfirmStartupBypass: !!bypass }),
  setEffectiveTheme: (theme) => set({ effectiveTheme: theme }),
  setUserCss: (css) => set({ userCss: css }),
  setUserCssPath: (path) => set({ userCssPath: path }),
  setEventSuppressionRules: (rules) => set({ eventSuppressionRules: Array.isArray(rules) ? rules : [] }),
  setActivePane: (pane) => set({ activePane: pane }),
  setConnected: (connected) => set({ connected }),
  setLiveUpdatesConnected: (connected) => set({ liveUpdatesConnected: connected }),
  restoreNav: (nav) =>
    set({
      activeContext: nav.activeContext,
      activeNamespace: nav.activeNamespace,
      selectedKind: nav.selectedKind,
      selectedKindLabel: nav.selectedKindLabel,
      selectedResource: nav.selectedResource,
      selectedResourceNamespace: nav.selectedResourceNamespace,
      activePane: nav.activePane,
    }),
}));
