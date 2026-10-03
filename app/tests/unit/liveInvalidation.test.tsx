import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useLiveResourceInvalidation } from '../../src/renderer/hooks/useLiveResourceInvalidation';
import { useAppStore } from '../../src/renderer/state/store';
import { resetAppStore } from './storeTestUtils';
import { useContextHealthStore } from '../../src/renderer/state/contextHealth';

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

  test('does not open the watch socket while the context needs sign-in, reconnects once healthy', async () => {
    useContextHealthStore.getState().clear();
    useAppStore.getState().setActiveContext('ctx-a');
    useContextHealthStore.getState().setHealth({ context: 'ctx-a', state: 'error', kind: 'AUTH_REQUIRED' });
    const resourcesKey = ['resources', 'ctx-a', 'default', '', 'v1', 'pods', ''];
    queryClient.setQueryData(resourcesKey, { items: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(useAppStore.getState().liveUpdatesConnected).toBe(false);

    await act(async () => {
      useContextHealthStore.getState().setHealth({ context: 'ctx-a', state: 'ok', kind: '' });
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(queryClient.getQueryState(resourcesKey)?.isInvalidated).toBe(true);
    useContextHealthStore.getState().clear();
  });

  test('a rejected upgrade checks context health and stops reconnecting on AUTH_*', async () => {
    useContextHealthStore.getState().clear();
    useAppStore.getState().setActiveContext('ctx-a');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      context: 'ctx-a', state: 'error', kind: 'AUTH_REQUIRED', suggested_command: 'gcloud auth login',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    // Server rejects the upgrade with 401: the browser only sees a close before open.
    await act(async () => {
      MockWebSocket.instances[0].close();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/context-health?context=ctx-a');
    expect(useContextHealthStore.getState().byContext['ctx-a']?.kind).toBe('AUTH_REQUIRED');

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.unstubAllGlobals();
    useContextHealthStore.getState().clear();
  });

  test('a health message on an open socket updates the store and closes the socket', async () => {
    useContextHealthStore.getState().clear();
    useAppStore.getState().setActiveContext('ctx-a');
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const socket = MockWebSocket.instances[0];
    await act(async () => {
      socket.readyState = MockWebSocket.OPEN;
      socket.onopen?.(new Event('open'));
      socket.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({ type: 'health', health: { context: 'ctx-a', state: 'error', kind: 'AUTH_REJECTED' } }),
      }));
      await Promise.resolve();
    });
    expect(useContextHealthStore.getState().byContext['ctx-a']?.kind).toBe('AUTH_REJECTED');
    expect(socket.close).toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    useContextHealthStore.getState().clear();
  });
});
