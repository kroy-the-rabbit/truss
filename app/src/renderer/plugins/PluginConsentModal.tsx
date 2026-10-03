import React, { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import type { PluginRecord } from './types';

export const PLUGIN_TRUST_WARNING =
  'Plugins run inside Truss with access to your clusters. Only enable plugins you trust.';

type Decision = 'approved' | 'denied' | 'busy';

interface Props {
  plugins: PluginRecord[];
  // Resolves true if the user confirmed in main's native dialog.
  onApprove(record: PluginRecord): Promise<boolean>;
  onDeny(pluginId: string): Promise<void>;
  onDone(): void;
}

export function PluginDeclarations({ record }: { record: PluginRecord }) {
  const caps = Array.isArray(record.manifest.capabilities) ? record.manifest.capabilities : [];
  return (
    <dl className="plugin-consent-details">
      <dt>Folder</dt>
      <dd><code>{record.path}</code></dd>
      <dt>Entry</dt>
      <dd><code>{String(record.manifest.entry ?? '')}</code></dd>
      {record.manifest.author && (<><dt>Author</dt><dd>{record.manifest.author}</dd></>)}
      <dt>Declares</dt>
      <dd>
        {caps.length === 0 ? (
          <span className="plugin-section-empty">No contributions declared</span>
        ) : (
          <span className="plugin-capabilities">
            {caps.map((cap) => <span key={cap} className="plugin-badge">{cap}</span>)}
          </span>
        )}
      </dd>
      {record.fingerprint && (<><dt>Fingerprint</dt><dd><code>{record.fingerprint.slice(0, 16)}</code></dd></>)}
    </dl>
  );
}

/**
 * Startup consent prompt for third-party plugins that have no decision yet
 * (newly installed, installed before consent existed, or changed since they
 * were approved). Each choice persists in main. Closing the dialog keeps any
 * undecided plugins disabled, so every plugin is asked about once.
 */
export function PluginConsentModal({ plugins, onApprove, onDeny, onDone }: Props) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});

  const allDecided = plugins.every((p) => decisions[p.manifest.id] === 'approved' || decisions[p.manifest.id] === 'denied');
  useEffect(() => {
    if (allDecided) onDone();
  // onDone identity is irrelevant; fire once when the last choice lands.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDecided]);

  const decide = async (record: PluginRecord, approve: boolean) => {
    const id = record.manifest.id;
    setDecisions((d) => ({ ...d, [id]: 'busy' }));
    let result: Decision | undefined;
    if (approve) {
      result = (await onApprove(record)) ? 'approved' : undefined;
    } else {
      await onDeny(id);
      result = 'denied';
    }
    setDecisions((d) => {
      const next = { ...d };
      if (result) next[id] = result;
      else delete next[id]; // cancelled in the native dialog: still undecided
      return next;
    });
  };

  const keepRemainingDisabled = async () => {
    for (const p of plugins) {
      const d = decisions[p.manifest.id];
      if (d !== 'approved' && d !== 'denied') await onDeny(p.manifest.id);
    }
    onDone();
  };

  return (
    <Modal
      onClose={() => { void keepRemainingDisabled(); }}
      labelledBy="plugin-consent-title"
      contentClassName="modal-content plugin-consent-modal"
      initialFocusSelector=".plugin-consent-keep"
      closeOnOverlayClick={false}
    >
      <div className="modal-header">
        <h2 id="plugin-consent-title">Review plugins</h2>
      </div>
      <div className="plugin-consent-body">
        <p className="plugin-consent-warning" role="alert">{PLUGIN_TRUST_WARNING}</p>
        <p className="preferences-hint">
          These plugins are disabled until you approve them. If a plugin&apos;s code changes, it is disabled again until re-approved.
        </p>
        {plugins.map((record) => {
          const id = record.manifest.id;
          const d = decisions[id];
          return (
            <div key={id} className="plugin-card" data-testid={`plugin-consent-${id}`}>
              <div className="plugin-card-header">
                <div className="plugin-card-title">
                  <span className="plugin-name">{record.manifest.name}</span>
                  <span className="plugin-version">v{record.manifest.version}</span>
                  {record.consent === 'changed' && <span className="plugin-badge">changed since approval</span>}
                </div>
              </div>
              {record.manifest.description && <p className="plugin-description">{record.manifest.description}</p>}
              <PluginDeclarations record={record} />
              <div className="preferences-actions">
                {d === 'approved' ? (
                  <span className="preferences-saved">Enabled</span>
                ) : d === 'denied' ? (
                  <span className="preferences-hint">Kept disabled</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="plugin-open-dir-btn"
                      disabled={d === 'busy'}
                      onClick={() => { void decide(record, true); }}
                      aria-label={`Approve ${record.manifest.name}`}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="plugin-open-dir-btn plugin-consent-keep"
                      disabled={d === 'busy'}
                      onClick={() => { void decide(record, false); }}
                      aria-label={`Keep ${record.manifest.name} disabled`}
                    >
                      Keep disabled
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        <div className="preferences-actions plugin-consent-footer">
          <button type="button" className="plugin-open-dir-btn" onClick={() => { void keepRemainingDisabled(); }}>
            Keep remaining disabled
          </button>
          <span className="preferences-hint">You can review plugins later in Preferences → Plugins.</span>
        </div>
      </div>
    </Modal>
  );
}
