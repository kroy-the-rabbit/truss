import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginConsentModal, PLUGIN_TRUST_WARNING } from '../../src/renderer/plugins/PluginConsentModal';
import type { PluginRecord } from '../../src/renderer/plugins/types';

function rec(id: string, extra: Partial<PluginRecord> = {}): PluginRecord {
  return {
    manifest: {
      id,
      name: `Plugin ${id}`,
      version: '2.3.4',
      apiVersion: '1',
      capabilities: ['inspector-tab', 'action-button'],
      entry: 'dist/index.js',
      description: `Does ${id} things`,
    },
    enabled: false,
    path: `/home/u/.config/truss/plugins/${id}`,
    isBuiltin: false,
    consent: 'pending',
    needsConsent: true,
    fingerprint: 'abcdef0123456789ffff',
    ...extra,
  };
}

describe('PluginConsentModal', () => {
  test('shows name, version, folder, declarations and the trust warning', () => {
    render(
      <PluginConsentModal plugins={[rec('alpha'), rec('beta', { consent: 'changed' })]} onApprove={vi.fn()} onDeny={vi.fn()} onDone={vi.fn()} />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(PLUGIN_TRUST_WARNING)).toBeInTheDocument();
    expect(PLUGIN_TRUST_WARNING).toBe('Plugins run inside Truss with access to your clusters. Only enable plugins you trust.');
    expect(screen.getByText('Plugin alpha')).toBeInTheDocument();
    expect(screen.getAllByText('v2.3.4')).toHaveLength(2);
    expect(screen.getByText('/home/u/.config/truss/plugins/alpha')).toBeInTheDocument();
    expect(screen.getAllByText('inspector-tab')).toHaveLength(2);
    expect(screen.getAllByText('action-button')).toHaveLength(2);
    expect(screen.getByText('changed since approval')).toBeInTheDocument();
  });

  test('approve and keep-disabled act per plugin, then finish', async () => {
    const onApprove = vi.fn(async () => true);
    const onDeny = vi.fn(async () => {});
    const onDone = vi.fn();
    render(<PluginConsentModal plugins={[rec('alpha'), rec('beta')]} onApprove={onApprove} onDeny={onDeny} onDone={onDone} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve Plugin alpha' }));
    await screen.findByText('Enabled');
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ id: 'alpha' }) }));
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep Plugin beta disabled' }));
    await screen.findByText('Kept disabled');
    expect(onDeny).toHaveBeenCalledWith('beta');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  test('cancelling the native confirmation leaves the plugin undecided', async () => {
    const onApprove = vi.fn(async () => false);
    const onDone = vi.fn();
    render(<PluginConsentModal plugins={[rec('alpha')]} onApprove={onApprove} onDeny={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Plugin alpha' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve Plugin alpha' })).not.toBeDisabled());
    expect(onDone).not.toHaveBeenCalled();
  });

  test('dismissing keeps undecided plugins disabled so they are asked once', async () => {
    const onApprove = vi.fn(async () => true);
    const onDeny = vi.fn(async () => {});
    const onDone = vi.fn();
    render(<PluginConsentModal plugins={[rec('alpha'), rec('beta'), rec('gamma')]} onApprove={onApprove} onDeny={onDeny} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Plugin alpha' }));
    await screen.findByText('Enabled');

    fireEvent.click(screen.getByRole('button', { name: 'Keep remaining disabled' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDeny.mock.calls.map((c) => c[0]).sort()).toEqual(['beta', 'gamma']);
  });
});
