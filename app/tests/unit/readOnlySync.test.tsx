import { describe, expect, beforeEach, afterEach, test, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAppStore } from '../../src/renderer/state/store';
import { resetAppStore } from './storeTestUtils';

// Fake daemon: holds the server-side read-only flag behind /api/readonly.
const daemon = { readonly: true, reachable: true, posts: [] as boolean[] };

vi.mock('../../src/renderer/api/client', () => ({
  fetchSetupAPI: vi.fn(async (path: string, options?: RequestInit) => {
    if (path !== '/api/readonly') throw new Error(`unexpected path ${path}`);
    if (!daemon.reachable) throw new Error('Daemon not connected');
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)) as { readonly: boolean };
      daemon.posts.push(body.readonly);
      daemon.readonly = body.readonly;
    }
    return new Response(JSON.stringify({ readonly: daemon.readonly }), { status: 200 });
  }),
}));

import {
  syncReadOnlyToDaemon,
  reconcileReadOnly,
  useReadOnlySync,
  useDaemonReadOnly,
} from '../../src/renderer/state/readOnlySync';
import { friendlyErrorMessage, READ_ONLY_USER_MESSAGE } from '../../src/renderer/api/readOnlyErrors';

describe('read-only daemon sync', () => {
  beforeEach(() => {
    resetAppStore();
    daemon.readonly = true;
    daemon.reachable = true;
    daemon.posts = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('pushes every toggle to the daemon', async () => {
    const { unmount } = renderHook(() => useReadOnlySync(60_000));
    await waitFor(() => expect(daemon.posts).toEqual([true]));

    act(() => useAppStore.getState().setReadOnly(false));
    await waitFor(() => expect(daemon.readonly).toBe(false));
    expect(useAppStore.getState().readOnly).toBe(false);

    act(() => useAppStore.getState().setReadOnly(true));
    await waitFor(() => expect(daemon.readonly).toBe(true));
    expect(daemon.posts).toEqual([true, false, true]);
    unmount();
  });

  test('fails closed: UI returns to RO when the push fails', async () => {
    daemon.reachable = false;
    useAppStore.getState().setReadOnly(false);
    await syncReadOnlyToDaemon();
    expect(useAppStore.getState().readOnly).toBe(true);
  });

  test('reconcile after a daemon restart forces the UI back to RO', async () => {
    useAppStore.getState().setReadOnly(false);
    await syncReadOnlyToDaemon();
    expect(daemon.readonly).toBe(false);

    // Daemon restarts: comes back read-only.
    daemon.readonly = true;
    await reconcileReadOnly();
    expect(useAppStore.getState().readOnly).toBe(true);
  });

  test('reconcile pushes RO when the UI is RO but the daemon is in write mode', async () => {
    daemon.readonly = false;
    await reconcileReadOnly();
    expect(daemon.readonly).toBe(true);
    expect(useAppStore.getState().readOnly).toBe(true);
  });

  test('reconcile with an unreachable daemon leaves the UI in RO', async () => {
    useAppStore.setState({ readOnly: false });
    daemon.reachable = false;
    await reconcileReadOnly();
    expect(useAppStore.getState().readOnly).toBe(true);
  });

  test('popout hook reads daemon state and fails closed', async () => {
    daemon.readonly = false;
    const { result, unmount } = renderHook(() => useDaemonReadOnly(60_000));
    expect(result.current).toBe(true);
    await waitFor(() => expect(result.current).toBe(false));
    unmount();

    daemon.reachable = false;
    const second = renderHook(() => useDaemonReadOnly(60_000));
    await new Promise((r) => setTimeout(r, 0));
    expect(second.result.current).toBe(true);
    second.unmount();
  });

  test('maps daemon read-only rejections to a clear message', () => {
    expect(friendlyErrorMessage(new Error('read-only mode is enabled'))).toBe(READ_ONLY_USER_MESSAGE);
    expect(friendlyErrorMessage(new Error('boom'))).toBe('boom');
  });
});
