import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Transport } from '@connectrpc/connect';
import {
  DEFAULT_RPC_TIMEOUT_MS,
  getHealthClient,
  resetTransport,
  rpcTimeoutMs,
  withDefaultTimeouts,
} from '../../src/renderer/api/client';
import { HealthService } from '../../src/renderer/api/gen/truss/v1/health_connect';
import { ResourcesService } from '../../src/renderer/api/gen/truss/v1/resources_connect';
import { HelmService } from '../../src/renderer/api/gen/truss/v1/helm_connect';
import { YamlService } from '../../src/renderer/api/gen/truss/v1/yaml_connect';

describe('RPC timeouts', () => {
  test('30s default, longer budgets for drain, helm actions and apply/diff', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(30_000);
    expect(rpcTimeoutMs(ResourcesService.methods.listResources.name)).toBe(30_000);
    expect(rpcTimeoutMs(ResourcesService.methods.drainNode.name)).toBe(600_000);
    expect(rpcTimeoutMs(HelmService.methods.upgradeRelease.name)).toBe(600_000);
    expect(rpcTimeoutMs(HelmService.methods.rollbackRelease.name)).toBe(600_000);
    expect(rpcTimeoutMs(HelmService.methods.uninstallRelease.name)).toBe(600_000);
    expect(rpcTimeoutMs(YamlService.methods.applyYaml.name)).toBe(120_000);
  });

  test('wrapper fills in the timeout only when the caller did not pass one', async () => {
    const unary = vi.fn(async () => ({}) as never);
    const stream = vi.fn(async () => ({}) as never);
    const t = withDefaultTimeouts({ unary, stream } as unknown as Transport);
    const ping = HealthService.methods.ping;
    await t.unary(HealthService, ping, undefined, undefined, undefined, {});
    await t.unary(HealthService, ping, undefined, 5, undefined, {});
    await t.unary(ResourcesService, ResourcesService.methods.drainNode, undefined, undefined, undefined, {});
    expect((unary.mock.calls as unknown[][]).map((c) => c[3])).toEqual([30_000, 5, 600_000]);
    await t.stream(HealthService, ping, undefined, undefined, undefined, (async function* () {})());
    expect((stream.mock.calls as unknown[][])[0][3]).toBeUndefined();
  });
});

describe('transport reset', () => {
  afterEach(() => {
    resetTransport();
    vi.unstubAllGlobals();
    delete (window as any).electronAPI;
  });

  test('resetTransport rebuilds from the current daemon config', async () => {
    const getDaemonConfig = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ port: 1111, token: 'old' })
      .mockResolvedValueOnce({ port: 2222, token: 'new' });
    (window as any).electronAPI = { getDaemonConfig };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    // Daemon not ready: the failure is not cached.
    await expect(getHealthClient()).rejects.toThrow('Daemon not connected');

    await (await getHealthClient()).ping({});
    await (await getHealthClient()).ping({});
    expect(getDaemonConfig).toHaveBeenCalledTimes(2);

    resetTransport();
    await (await getHealthClient()).ping({});
    expect(getDaemonConfig).toHaveBeenCalledTimes(3);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(String(calls[0][0])).toContain('127.0.0.1:1111');
    expect(String(calls[2][0])).toContain('127.0.0.1:2222');
    const headers = new Headers(calls[2][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer new');
    expect(headers.get('Connect-Timeout-Ms')).toBe('30000');
  });
});
