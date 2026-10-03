import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ContextAuthBanner } from '../../src/renderer/components/ContextAuthBanner';
import {
  type ContextHealth,
  useContextHealthStore,
} from '../../src/renderer/state/contextHealth';

const CTX = 'gke-prod';

function health(partial: Partial<ContextHealth>): ContextHealth {
  return {
    context: CTX,
    state: 'error',
    kind: 'AUTH_REQUIRED',
    message: 'exec plugin: token expired',
    plugin_command: '/usr/lib/google-cloud-sdk/bin/gke-gcloud-auth-plugin',
    suggested_command: 'gcloud auth login',
    stderr: 'ERROR: (gcloud) Reauthentication required.',
    since: '2026-10-02T10:00:00Z',
    ...partial,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let clipboardWriteText: ReturnType<typeof vi.fn>;
let queryClient: QueryClient;
let currentHealth: ContextHealth;
let reauthResult: ContextHealth;

function renderBanner() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ContextAuthBanner context={CTX} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useContextHealthStore.getState().clear();
  currentHealth = health({});
  reauthResult = health({ state: 'ok', kind: '', message: '', stderr: '' });
  clipboardWriteText = vi.fn().mockResolvedValue(undefined);
  (window as any).electronAPI = {
    getDaemonConfig: vi.fn().mockResolvedValue({ port: 4242, token: 'tok' }),
    clipboardWriteText,
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/context-health')) return jsonResponse(currentHealth);
    if (url.endsWith('/api/contexts/reauth') && init?.method === 'POST') return jsonResponse(reauthResult);
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  delete (window as any).electronAPI;
});

describe('ContextAuthBanner', () => {
  test('renders nothing when the context is healthy', async () => {
    currentHealth = health({ state: 'ok', kind: '' });
    const { container } = renderBanner();
    await waitFor(() => expect(useContextHealthStore.getState().byContext[CTX]?.state).toBe('ok'));
    expect(container).toBeEmptyDOMElement();
  });

  test('AUTH_REQUIRED shows sign-in heading, plugin, command and details', async () => {
    renderBanner();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`Sign-in required for ${CTX}`);
    expect(alert).toHaveTextContent('gke-gcloud-auth-plugin');
    expect(screen.getByLabelText('Suggested command')).toHaveTextContent('gcloud auth login');
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(alert).toHaveTextContent('Reauthentication required');
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4242/api/context-health?context=${CTX}`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
  });

  test('AUTH_PLUGIN_MISSING shows an install/PATH hint', async () => {
    currentHealth = health({ kind: 'AUTH_PLUGIN_MISSING', suggested_command: 'gcloud components install gke-gcloud-auth-plugin' });
    renderBanner();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not find `gke-gcloud-auth-plugin`/);
    expect(alert).toHaveTextContent(/PATH/);
  });

  test('AUTH_INTERACTIVE_UNSUPPORTED tells the user to run the command in a terminal', async () => {
    currentHealth = health({ kind: 'AUTH_INTERACTIVE_UNSUPPORTED', plugin_command: 'kubelogin', suggested_command: 'kubelogin get-token' });
    renderBanner();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Run the command below once in a terminal to cache credentials/);
  });

  test('UNREACHABLE renders the quieter status variant', async () => {
    currentHealth = health({ kind: 'UNREACHABLE', message: 'dial tcp 10.0.0.1:443: i/o timeout', suggested_command: '' });
    renderBanner();
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(`Cluster unreachable: ${CTX}`);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('FORBIDDEN does not render a banner', async () => {
    currentHealth = health({ kind: 'FORBIDDEN' });
    const { container } = renderBanner();
    await waitFor(() => expect(useContextHealthStore.getState().byContext[CTX]?.kind).toBe('FORBIDDEN'));
    expect(container).toBeEmptyDOMElement();
  });

  test('Copy writes the suggested command to the clipboard', async () => {
    renderBanner();
    const copy = await screen.findByRole('button', { name: 'Copy command' });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(clipboardWriteText).toHaveBeenCalledWith('gcloud auth login');
    expect(copy).toHaveTextContent('Copied');
  });

  test('Retry posts reauth, clears the banner and invalidates the context queries', async () => {
    const resourcesKey = ['resources', CTX, 'default', '', 'v1', 'pods', ''];
    const otherKey = ['resources', 'other', 'default', '', 'v1', 'pods', ''];
    queryClient.setQueryData(resourcesKey, { items: [] });
    queryClient.setQueryData(otherKey, { items: [] });

    renderBanner();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    await act(async () => {
      fireEvent.click(retry);
    });

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    const reauthCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/contexts/reauth'));
    expect(reauthCall?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ context: CTX }) });
    expect(useContextHealthStore.getState().byContext[CTX]?.state).toBe('ok');
    expect(queryClient.getQueryState(resourcesKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  test('Retry that still needs auth keeps the banner and does not invalidate', async () => {
    const resourcesKey = ['resources', CTX, 'default', '', 'v1', 'pods', ''];
    queryClient.setQueryData(resourcesKey, { items: [] });
    reauthResult = health({ stderr: 'still expired' });
    renderBanner();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('still expired'));
    expect(queryClient.getQueryState(resourcesKey)?.isInvalidated).toBe(false);
  });

  test('window focus auto-retries at most once per 30s', async () => {
    reauthResult = health({});
    renderBanner();
    await screen.findByRole('alert');
    const nowSpy = vi.spyOn(Date, 'now');
    const reauthCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/contexts/reauth')).length;

    nowSpy.mockReturnValue(1_000_000);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(reauthCalls()).toBe(1));

    nowSpy.mockReturnValue(1_010_000);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(reauthCalls()).toBe(1);

    nowSpy.mockReturnValue(1_031_000);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(reauthCalls()).toBe(2));
    nowSpy.mockRestore();
  });
});
