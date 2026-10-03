import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from './Modal';
import {
  type ContextHealth,
  type SensitiveAuth,
  postApproveExec,
  recordContextHealth,
} from '../state/contextHealth';
import { invalidateContextAfterRecovery } from '../state/queries';

export const EXEC_RUN_WARNING =
  'Truss will run this command on your computer with your user permissions whenever it connects to this cluster.';
const NON_EXEC_WARNING =
  'Truss will use this authentication configuration and read these local files whenever it connects to this cluster.';

export interface PendingExecApproval {
  name: string;
  sensitive: SensitiveAuth;
}

type Decision = { kind: 'approved'; health: ContextHealth } | { kind: 'declined' };

/** Read-only rendering of what a context runs or reads locally. */
export function SensitiveAuthDetails({ sensitive }: { sensitive: SensitiveAuth }) {
  const { exec, auth_provider: authProvider, file_refs: fileRefs } = sensitive;
  return (
    <div className="exec-approval-details">
      {exec && (
        <>
          <div className="exec-approval-label">Command</div>
          <pre className="exec-approval-command" aria-label="Command line">{exec.command_line}</pre>
          {exec.env_names.length > 0 && (
            <div className="exec-approval-row">
              <span className="exec-approval-label">Environment variables:</span>{' '}
              <code>{exec.env_names.join(', ')}</code>
            </div>
          )}
          {exec.api_version && (
            <div className="exec-approval-row">
              <span className="exec-approval-label">Credential API:</span> <code>{exec.api_version}</code>
            </div>
          )}
        </>
      )}
      {authProvider && (
        <div className="exec-approval-row">
          <span className="exec-approval-label">Auth provider:</span> <code>{authProvider}</code>
        </div>
      )}
      {fileRefs && fileRefs.length > 0 && (
        <div className="exec-approval-row">
          <div className="exec-approval-label">Local files read</div>
          <ul className="exec-approval-files">
            {fileRefs.map((f) => (
              <li key={`${f.field}:${f.path}`}>
                <code>{f.path}</code> <span className="exec-approval-field">({f.field})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="exec-approval-warning" role="note">
        {exec ? EXEC_RUN_WARNING : NON_EXEC_WARNING}
      </p>
    </div>
  );
}

interface Props {
  items: PendingExecApproval[];
  onClose: () => void;
  /** Called after each decision (health is set for an approval). */
  onDecided?: (name: string, approved: boolean, health?: ContextHealth) => void;
}

/**
 * Asks the user to approve each context whose kubeconfig runs a command (exec
 * plugin / auth-provider) or reads local files. Nothing runs until approved.
 */
export function ExecApprovalModal({ items, onClose, onDecided }: Props) {
  const qc = useQueryClient();
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const allDecided = items.length > 0 && items.every((i) => decisions[i.name]);
  useEffect(() => {
    if (allDecided) onClose();
  }, [allDecided, onClose]);

  const approve = async (item: PendingExecApproval) => {
    setBusy(item.name);
    setErrors((e) => ({ ...e, [item.name]: '' }));
    try {
      const health = await postApproveExec(item.name, item.sensitive.fingerprint);
      recordContextHealth(health, qc);
      if (health.state === 'ok') invalidateContextAfterRecovery(qc, item.name);
      setDecisions((d) => ({ ...d, [item.name]: { kind: 'approved', health } }));
      onDecided?.(item.name, true, health);
    } catch (err) {
      setErrors((e) => ({ ...e, [item.name]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
    }
  };

  const decline = (item: PendingExecApproval) => {
    setDecisions((d) => ({ ...d, [item.name]: { kind: 'declined' } }));
    onDecided?.(item.name, false);
  };

  return (
    <Modal
      onClose={onClose}
      labelledBy="exec-approval-title"
      contentClassName="modal-content exec-approval-modal"
      closeOnOverlayClick={false}
    >
      <div className="modal-header">
        <h2 id="exec-approval-title">Approve authentication commands</h2>
        <button className="modal-close" aria-label="Close approval dialog" onClick={onClose}>×</button>
      </div>
      <div className="exec-approval-body">
        <p className="exec-approval-intro">
          {items.length === 1 ? 'This context authenticates' : 'These contexts authenticate'} by running a
          program or reading files on your computer. Truss will not connect until you approve. Only approve
          commands you recognise and trust.
        </p>
        {items.map((item) => {
          const decision = decisions[item.name];
          return (
            <section key={item.name} className="exec-approval-item" aria-label={`Context ${item.name}`}>
              <h3 className="exec-approval-name">{item.name}</h3>
              <SensitiveAuthDetails sensitive={item.sensitive} />
              {errors[item.name] && (
                <div className="cm-error" role="alert">{errors[item.name]}</div>
              )}
              {decision ? (
                <div className="exec-approval-status">
                  {decision.kind === 'approved' ? 'Approved' : "Not approved. Truss won't connect to this context."}
                </div>
              ) : (
                <div className="exec-approval-actions">
                  <button
                    type="button"
                    className="setup-btn-primary"
                    onClick={() => void approve(item)}
                    disabled={busy !== null}
                  >
                    {busy === item.name ? 'Approving…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="setup-btn-secondary"
                    onClick={() => decline(item)}
                    disabled={busy !== null}
                  >
                    Don&apos;t approve
                  </button>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
