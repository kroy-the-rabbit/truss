import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useLiveResourceInvalidation } from '../../src/renderer/hooks/useLiveResourceInvalidation';
import { useAppStore } from '../../src/renderer/state/store';
import { resetAppStore } from './storeTestUtils';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  });

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }
}

function Harness() {
  useLiveResourceInvalidation();
  return null;
}

describe('useLiveResourceInvalidation idle refresh', () => {
  let originalWebSocket: typeof WebSocket;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00.000Z'));
    resetAppStore();
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    (window as any).electronAPI = {
      getDaemonConfig: vi.fn().mockResolvedValue({ port: 12345, token: 'test-token' }),
    };
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  afterEach(() => {
    queryClient.clear();
    globalThis.WebSocket = originalWebSocket;
    delete (window as any).electronAPI;
    vi.useRealTimers();
  });

  test('foreground after a quiet period invalidates active context resources and helm views', async () => {
    useAppStore.getState().setActiveContext('ctx-a');
    useAppStore.getState().setActiveNamespace('default');

    const resourcesKey = ['resources', 'ctx-a', 'default', '', 'v1', 'pods', ''];
    const helmKey = ['helmRelease', 'ctx-a', 'default', 'api'];
    const otherContextKey = ['resources', 'ctx-b', 'default', '', 'v1', 'pods', ''];
    queryClient.setQueryData(resourcesKey, { items: [] });
    queryClient.setQueryData(helmKey, { name: 'api' });
    queryClient.setQueryData(otherContextKey, { items: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];

    await act(async () => {
      socket.readyState = MockWebSocket.OPEN;
      socket.onopen?.(new Event('open'));
      vi.advanceTimersByTime(31_000);
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(queryClient.getQueryState(resourcesKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(helmKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherContextKey)?.isInvalidated).toBe(false);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
