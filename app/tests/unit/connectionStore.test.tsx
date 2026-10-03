import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  resetTransport: vi.fn(),
  pingImpl: vi.fn(async () => ({})),
}));

vi.mock('../../src/renderer/api/client', () => {
  const rejecting = () => new Proxy({}, { get: () => () => new Promise(() => {}) });
  return {
    resetTransport: clientMocks.resetTransport,
    fetchSetupAPI: vi.fn(() => new Promise(() => {})),
    getHealthClient: vi.fn(async () => ({ ping: clientMocks.pingImpl })),
    getContextsClient: vi.fn(async () => rejecting()),
    getDiscoveryClient: vi.fn(async () => rejecting()),
    getResourcesClient: vi.fn(async () => rejecting()),
    getYamlClient: vi.fn(async () => rejecting()),
    getHelmClient: vi.fn(async () => rejecting()),
    getOverviewClient: vi.fn(async () => rejecting()),
  };
});

import {
  applyDaemonState,
  deriveDaemonIndicator,
  useConnectionStore,
  useConnectionSync,
} from '../../src/renderer/state/connectionStore';
import { usePing } from '../../src/renderer/state/queries';

function seed(qc: QueryClient) {
  const keys = {
    resources: ['resources', 'ctx-a', 'default', '', 'v1', 'pods', ''],
    helm: ['helmReleases', 'ctx-b', ''],
    health: ['contextHealth', 'ctx-a'],
    unrelated: ['profiles'],
  };
  for (const k of Object.values(keys)) qc.setQueryData(k, { x: 1 });
  return keys;
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('connectionStore', () => {
  let qc: QueryClient;

  beforeEach(() => {
    useConnectionStore.getState().reset();
    clientMocks.resetTransport.mockClear();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    qc.clear();
    delete (window as any).electronAPI;
  });

  test('the first report only records state', () => {
    const keys = seed(qc);
    const onDaemonRestart = vi.fn();
    const epoch = applyDaemonState({ status: 'ready', epoch: 3 }, null, null, qc, { onDaemonRestart });
    expect(epoch).toBe(3);
    expect(useConnectionStore.getState().supported).toBe(true);
    expect(useConnectionStore.getState().daemon).toEqual({ status: 'ready', epoch: 3 });
    expect(clientMocks.resetTransport).not.toHaveBeenCalled();
    expect(onDaemonRestart).not.toHaveBeenCalled();
    expect(qc.getQueryState(keys.resources)?.isInvalidated).toBe(false);
  });

  test('an epoch change resets the transport, invalidates daemon data and reconciles RO', () => {
    const keys = seed(qc);
    const onDaemonRestart = vi.fn();
    applyDaemonState({ status: 'restarting', epoch: 3 }, 3, 'ready', qc, { onDaemonRestart });
    expect(onDaemonRestart).not.toHaveBeenCalled();
    applyDaemonState({ status: 'ready', epoch: 4 }, 3, 'restarting', qc, { onDaemonRestart });
    expect(clientMocks.resetTransport).toHaveBeenCalled();
    expect(onDaemonRestart).toHaveBeenCalledTimes(1);
    expect(qc.getQueryState(keys.resources)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.helm)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.health)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.unrelated)?.isInvalidated).toBe(false);
  });

  test('useConnectionSync subscribes to main-process events and reacts to epoch and resume', async () => {
    const keys = seed(qc);
    let daemonCb: ((s: unknown) => void) | null = null;
    let resumeCb: (() => void) | null = null;
    const unsubDaemon = vi.fn();
    const unsubResume = vi.fn();
    (window as any).electronAPI = {
      getDaemonConfig: vi.fn(async () => ({ port: 1, token: 't' })),
      getDaemonState: vi.fn(async () => ({ status: 'ready', epoch: 1 })),
      onDaemonState: vi.fn((cb: (s: unknown) => void) => { daemonCb = cb; return unsubDaemon; }),
      onSystemResume: vi.fn((cb: () => void) => { resumeCb = cb; return unsubResume; }),
    };
    const onDaemonRestart = vi.fn();
    function Harness() {
      useConnectionSync(qc, { onDaemonRestart });
      return null;
    }
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    );
    await act(flush);
    expect(useConnectionStore.getState().daemon).toEqual({ status: 'ready', epoch: 1 });
    expect(clientMocks.resetTransport).not.toHaveBeenCalled();

    await act(async () => {
      daemonCb?.({ status: 'restarting', epoch: 1 });
      daemonCb?.({ status: 'ready', epoch: 2 });
      await flush();
    });
    expect(clientMocks.resetTransport).toHaveBeenCalled();
    expect(onDaemonRestart).toHaveBeenCalledTimes(1);
    expect(qc.getQueryState(keys.resources)?.isInvalidated).toBe(true);

    // Garbage payloads are ignored.
    await act(async () => {
      daemonCb?.({ status: 'bogus' });
      await flush();
    });
    expect(useConnectionStore.getState().daemon.epoch).toBe(2);

    qc.setQueryData(keys.resources, { x: 2 });
    expect(qc.getQueryState(keys.resources)?.isInvalidated).toBe(false);
    await act(async () => {
      resumeCb?.();
      await flush();
    });
    expect(useConnectionStore.getState().lastResumeAt).toBeGreaterThan(0);
    expect(qc.getQueryState(keys.resources)?.isInvalidated).toBe(true);

    unmount();
    expect(unsubDaemon).toHaveBeenCalled();
    expect(unsubResume).toHaveBeenCalled();
  });

  test('older main process without daemon-state APIs is tolerated', async () => {
    (window as any).electronAPI = { getDaemonConfig: vi.fn(async () => null) };
    function Harness() {
      useConnectionSync(qc);
      return null;
    }
    render(<Harness />);
    await act(flush);
    expect(useConnectionStore.getState().supported).toBe(false);
  });
});

describe('daemon indicator', () => {
  const base = { supported: true, pingSuccess: true, pingError: false };

  test('maps daemon states to green / amber / red', () => {
    expect(deriveDaemonIndicator({ ...base, daemon: { status: 'ready', epoch: 1 } }).level).toBe('ok');
    const restarting = deriveDaemonIndicator({ ...base, daemon: { status: 'restarting', epoch: 1 } });
    expect(restarting.level).toBe('reconnecting');
    expect(restarting.label).toBe('Reconnecting…');
    const failed = deriveDaemonIndicator({ ...base, daemon: { status: 'failed', epoch: 1, error: 'exit status 2' } });
    expect(failed.level).toBe('down');
    expect(failed.title).toContain('exit status 2');
  });

  test('a failed ping is red even with stale success data', () => {
    const ind = deriveDaemonIndicator({
      ...base,
      supported: false,
      daemon: { status: 'starting', epoch: 0 },
      pingSuccess: false,
      pingError: true,
      pingErrorMessage: 'Failed to fetch',
    });
    expect(ind.level).toBe('down');
    expect(ind.title).toContain('Failed to fetch');
  });
});

describe('usePing', () => {
  test('does not retry: a failure after a success surfaces as an error', async () => {
    useConnectionStore.getState().reset();
    const qc = new QueryClient();
    let result: ReturnType<typeof usePing> | null = null;
    function Harness() {
      result = usePing();
      return null;
    }
    clientMocks.pingImpl.mockResolvedValueOnce({});
    render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(result!.isSuccess).toBe(true));

    clientMocks.pingImpl.mockRejectedValue(new Error('connection refused'));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['ping'] });
      await flush();
    });
    expect(clientMocks.pingImpl).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result!.isError).toBe(true));
    expect(result!.isSuccess).toBe(false);
    const ind = deriveDaemonIndicator({
      supported: false,
      daemon: useConnectionStore.getState().daemon,
      pingSuccess: result!.isSuccess,
      pingError: result!.isError,
    });
    expect(ind.level).toBe('down');
    qc.clear();
  });
});
