// Renderer plugin loader: consent gating and per-plugin storage binding.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PluginCapabilityRegistry } from '../../src/main/pluginConsent';
import type { PluginRecord, PluginAPI } from '../../src/renderer/plugins/types';

vi.mock('../../src/renderer/api/client', () => ({
  getYamlClient: vi.fn(),
  fetchSetupAPI: vi.fn(() => { throw new Error('plugins must not call the daemon setup API directly'); }),
}));

const OWNER = 1;

function record(id: string, consent: PluginRecord['consent'], extra: Partial<PluginRecord> = {}): PluginRecord {
  return {
    manifest: { id, name: id, version: '1.0.0', apiVersion: '1', capabilities: [], entry: 'index.js' },
    enabled: consent === 'approved',
    path: `/plugins/${id}`,
    isBuiltin: false,
    consent,
    needsConsent: consent === 'pending' || consent === 'changed',
    ...extra,
  };
}

// Plugin code that stashes the API it was given on globalThis for inspection.
function pluginCode(id: string): string {
  return `export function register(api) { (globalThis.__apis ||= {})[${JSON.stringify(id)}] = api; }`;
}

// A fake main process: mints capabilities with the real registry and keeps
// per-plugin storage keyed by the plugin id it derives from the capability.
function installFakeMain(approved: string[]) {
  const caps = new PluginCapabilityRegistry();
  const storage: Record<string, Record<string, unknown>> = {};
  const resolve = (cap: unknown) => {
    const id = caps.resolve(OWNER, cap);
    if (!id || !approved.includes(id)) throw new Error('Invalid plugin storage capability');
    return id;
  };
  const api = {
    pluginList: vi.fn(async () => []),
    pluginLoad: vi.fn(async (ids: string[]) => ids.map((pluginId) => (
      approved.includes(pluginId)
        ? { pluginId, code: pluginCode(pluginId), capability: caps.issue(OWNER, pluginId) }
        : { pluginId, error: 'Plugin is not approved or has changed since approval' }
    ))),
    pluginStorageGet: vi.fn(async (cap: unknown, key: string) => storage[resolve(cap)]?.[key] ?? null),
    pluginStorageSet: vi.fn(async (cap: unknown, key: string, value: unknown) => {
      const id = resolve(cap);
      (storage[id] ||= {})[key] = value;
    }),
    pluginStorageDelete: vi.fn(async () => undefined),
    pluginSecureStorage: vi.fn(async (cap: unknown, op: string, key: string) => {
      const id = resolve(cap);
      return op === 'get' ? `secret-of-${id}-${key}` : undefined;
    }),
    pluginSetApproval: vi.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).electronAPI = api;
  return { api, storage, caps };
}

beforeEach(() => {
  vi.resetModules();
  // Blob URLs are not importable under vitest; serve the code as a data: URL.
  vi.stubGlobal('Blob', class {
    parts: string[];
    constructor(parts: string[]) { this.parts = parts; }
  });
  URL.createObjectURL = ((blob: { parts: string[] }) =>
    `data:text/javascript;base64,${Buffer.from(blob.parts.join('')).toString('base64')}`) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__apis;
});

afterEach(() => {
  vi.unstubAllGlobals();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).electronAPI;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const apis = () => (globalThis as any).__apis as Record<string, PluginAPI>;

describe('plugin loader', () => {
  test('skips unapproved plugins and fetches approved code in one batch', async () => {
    const { api } = installFakeMain(['a', 'b']);
    const { loadPlugins, getLoadedPlugins } = await import('../../src/renderer/plugins/loader');
    const out = await loadPlugins([
      record('a', 'approved'),
      record('new', 'pending'),
      record('changed', 'changed'),
      record('off', 'denied'),
      record('b', 'approved'),
    ]);
    expect(api.pluginLoad).toHaveBeenCalledTimes(1);
    expect(api.pluginLoad).toHaveBeenCalledWith(['a', 'b']);
    expect(getLoadedPlugins().map((p) => p.manifest.id).sort()).toEqual(['a', 'b']);
    expect(Object.keys(apis()).sort()).toEqual(['a', 'b']);
    expect(out.map((r) => r.manifest.id)).toEqual(['a', 'new', 'changed', 'off', 'b']);
  });

  test('a record main refuses is reported, not loaded', async () => {
    installFakeMain([]);
    const { loadPlugins, getLoadedPlugins } = await import('../../src/renderer/plugins/loader');
    // Renderer claims approved, main disagrees (e.g. code changed on disk).
    const [res] = await loadPlugins([record('sneaky', 'approved')]);
    expect(res.enabled).toBe(false);
    expect(res.loadError).toMatch(/not approved/);
    expect(getLoadedPlugins()).toEqual([]);
  });

  test('builtins are never loaded through main', async () => {
    const { api } = installFakeMain([]);
    const { loadPlugins, isLoadable } = await import('../../src/renderer/plugins/loader');
    const builtin = { ...record('@truss/builtin', undefined), enabled: true, isBuiltin: true };
    expect(isLoadable(builtin)).toBe(false);
    await loadPlugins([builtin]);
    expect(api.pluginLoad).not.toHaveBeenCalled();
  });

  test('builtins register without any consent record', async () => {
    const { api } = installFakeMain([]);
    const { registerBuiltins } = await import('../../src/renderer/plugins/builtin/index');
    const { pluginRegistry } = await import('../../src/renderer/plugins/registry');
    registerBuiltins();
    expect(pluginRegistry.themeExtensions.length).toBeGreaterThan(0);
    expect(pluginRegistry.healthClassifiers.length).toBeGreaterThan(0);
    expect(api.pluginList).not.toHaveBeenCalled();
    expect(api.pluginLoad).not.toHaveBeenCalled();
  });
});

describe('plugin storage identity binding', () => {
  test('plugin A cannot read plugin B storage', async () => {
    const { api } = installFakeMain(['a', 'b']);
    const { loadPlugins } = await import('../../src/renderer/plugins/loader');
    await loadPlugins([record('a', 'approved'), record('b', 'approved')]);
    const { a, b } = apis();

    await b.storage.set('token', 'b-private');
    await a.storage.set('token', 'a-private');
    expect(await a.storage.get('token')).toBe('a-private');
    expect(await b.storage.get('token')).toBe('b-private');
    expect(await a.storage.secure.get('k')).toBe('secret-of-a-k');

    // Going around the API with B's plugin id fails: main wants a capability.
    await expect(api.pluginStorageGet('b', 'token')).rejects.toThrow(/capability/);
    // Re-requesting B's capability after the host claimed it yields nothing.
    const [again] = await api.pluginLoad(['b']);
    expect(again.capability).toBeNull();
  });

  test('API objects expose no daemon token or electronAPI handles', async () => {
    installFakeMain(['a']);
    const { loadPlugins } = await import('../../src/renderer/plugins/loader');
    await loadPlugins([record('a', 'approved')]);
    const a = apis().a as unknown as Record<string, unknown>;
    const json = JSON.stringify(a);
    expect(json).not.toMatch(/token|capability/i);
    expect(Object.keys(a)).not.toEqual(expect.arrayContaining(['getDaemonConfig']));
  });

  test('builtin/fallback API has no storage', async () => {
    installFakeMain([]);
    const { createPluginAPI } = await import('../../src/renderer/plugins/api');
    const api = createPluginAPI('@truss/builtin');
    await expect(api.storage.get('x')).rejects.toThrow(/not available/);
    await expect(api.storage.secure.get('x')).rejects.toThrow(/not available/);
  });
});

describe('approval flow', () => {
  test('approvePlugin loads only after main confirms', async () => {
    const { api, caps } = installFakeMain(['late']);
    api.pluginSetApproval
      .mockResolvedValueOnce({ approved: false, cancelled: true })
      .mockImplementationOnce(async () => ({ approved: true, code: pluginCode('late'), capability: caps.issue(OWNER, 'late') }));
    const { approvePlugin, getLoadedPlugins } = await import('../../src/renderer/plugins/loader');

    expect(await approvePlugin(record('late', 'pending'))).toBe(false);
    expect(getLoadedPlugins()).toEqual([]);

    expect(await approvePlugin(record('late', 'pending'))).toBe(true);
    expect(api.pluginSetApproval).toHaveBeenLastCalledWith('late', true);
    expect(getLoadedPlugins().map((p) => p.manifest.id)).toEqual(['late']);
    await apis().late.storage.set('x', 1);
    expect(await apis().late.storage.get('x')).toBe(1);
  });

  test('denyPlugin records the decision and unloads', async () => {
    const { api } = installFakeMain(['a']);
    api.pluginSetApproval.mockResolvedValue({ approved: false });
    const { loadPlugins, denyPlugin, getLoadedPlugins } = await import('../../src/renderer/plugins/loader');
    await loadPlugins([record('a', 'approved')]);
    await denyPlugin('a');
    expect(api.pluginSetApproval).toHaveBeenCalledWith('a', false);
    expect(getLoadedPlugins()).toEqual([]);
  });
});
