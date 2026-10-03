import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ping = vi.hoisted(() => ({ impl: vi.fn(async () => ({})) }));

vi.mock('../../src/renderer/api/client', () => {
  const pending = () => new Proxy({}, { get: () => () => new Promise(() => {}) });
  return {
    resetTransport: vi.fn(),
    fetchSetupAPI: vi.fn(() => new Promise(() => {})),
    getHealthClient: vi.fn(async () => ({ ping: ping.impl })),
    getContextsClient: vi.fn(async () => pending()),
    getDiscoveryClient: vi.fn(async () => pending()),
    getResourcesClient: vi.fn(async () => pending()),
    getYamlClient: vi.fn(async () => pending()),
    getHelmClient: vi.fn(async () => pending()),
    getOverviewClient: vi.fn(async () => pending()),
  };
});

import { TopBar } from '../../src/renderer/components/TopBar';
import { useConnectionStore } from '../../src/renderer/state/connectionStore';
import { useAppStore } from '../../src/renderer/state/store';
import { resetAppStore } from './storeTestUtils';

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('TopBar daemon indicator', () => {
  let qc: QueryClient;

  beforeEach(() => {
    resetAppStore();
    useConnectionStore.getState().reset();
    ping.impl.mockReset();
    qc = new QueryClient();
  });

  afterEach(() => qc.clear());

  function renderTopBar() {
    return render(
      <QueryClientProvider client={qc}>
        <TopBar />
      </QueryClientProvider>,
    );
  }

  test('green when the ping succeeds, red as soon as it fails (no silent retry)', async () => {
    ping.impl.mockResolvedValue({});
    renderTopBar();
    await waitFor(() => expect(useAppStore.getState().connected).toBe(true));
    const dot = screen.getByTestId('daemon-status-dot');
    expect(dot.className).not.toContain('disconnected');
    expect(dot.className).not.toContain('warning');

    ping.impl.mockRejectedValue(new Error('connection refused'));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['ping'] });
      await flush();
    });
    await waitFor(() => expect(screen.getByTestId('daemon-status-dot').className).toContain('disconnected'));
    expect(screen.getByText('Daemon unreachable')).toBeInTheDocument();
    expect(useAppStore.getState().connected).toBe(false);
  });

  test('amber "Reconnecting…" while the daemon restarts, red with error when it failed', async () => {
    ping.impl.mockResolvedValue({});
    renderTopBar();
    await act(flush);

    await act(async () => {
      useConnectionStore.getState().setDaemon({ status: 'restarting', epoch: 1 });
    });
    expect(screen.getByTestId('daemon-status-dot').className).toContain('warning');
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();

    await act(async () => {
      useConnectionStore.getState().setDaemon({ status: 'failed', epoch: 1, error: 'daemon exited: status 1' });
    });
    const dot = screen.getByTestId('daemon-status-dot');
    expect(dot.className).toContain('disconnected');
    expect(dot.getAttribute('title')).toContain('daemon exited: status 1');
  });
});
