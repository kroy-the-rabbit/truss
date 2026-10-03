import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  type ContextHealth,
  healthKindLabel,
  isAuthBlocked,
  isConnectivityError,
  pluginName,
  postContextReauth,
  recordContextHealth,
  useContextHealth,
} from '../state/contextHealth';
import { invalidateHelmViews, invalidateResourceViews } from '../state/queries';

export const AUTO_REAUTH_MIN_INTERVAL_MS = 30_000;

/** Refresh everything that was loaded (or failed) for a context once it is healthy again. */
export function invalidateContextAfterRecovery(qc: QueryClient, context: string) {
  invalidateResourceViews(qc, { context });
  invalidateHelmViews(qc, { context });
  qc.invalidateQueries({ queryKey: ['resourceKinds', context] });
  qc.invalidateQueries({ queryKey: ['contextPreflight', context] });
}

function authHint(health: ContextHealth, plugin: string): string {
  const p = plugin ? `\`${plugin}\`` : 'the credential plugin';
  switch (health.kind) {
    case 'AUTH_PLUGIN_MISSING':
      return `Truss could not find ${p}. Install it and make sure its directory is on the PATH of your login shell, then retry.`;
    case 'AUTH_INTERACTIVE_UNSUPPORTED':
      return `${p} needs an interactive prompt Truss cannot show. Run the command below once in a terminal to cache credentials, then retry.`;
    case 'AUTH_REJECTED':
      return 'The cluster rejected your credentials. Sign in again with the command below, then retry.';
    default:
      return 'Your credentials for this cluster are missing or expired. Run the command below in a terminal, then retry.';
  }
}

async function copyText(text: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).electronAPI;
  try {
    if (api?.clipboardWriteText) {
      await api.clipboardWriteText(text);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}

export function ContextAuthBanner({ context }: { context: string }) {
  const qc = useQueryClient();
  const health = useContextHealth(context);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const [copied, setCopied] = useState(false);
  const lastAutoReauthRef = useRef(0);
  const copiedTimerRef = useRef<number | null>(null);

  const authBlocked = isAuthBlocked(health);
  const connectivity = isConnectivityError(health);

  const retry = useCallback(async () => {
    if (!context) return;
    setRetrying(true);
    setRetryError('');
    try {
      const next = await postContextReauth(context);
      recordContextHealth(next, qc);
      if (next.state === 'ok') {
        // The live watch hook reconnects as soon as the store reports ok.
        invalidateContextAfterRecovery(qc, context);
      }
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [context, qc]);

  // Returning to the window after signing in elsewhere: re-probe, throttled.
  useEffect(() => {
    if (!authBlocked) return;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastAutoReauthRef.current < AUTO_REAUTH_MIN_INTERVAL_MS) return;
      lastAutoReauthRef.current = now;
      void retry();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [authBlocked, retry]);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  useEffect(() => {
    setRetryError('');
    setCopied(false);
  }, [context]);

  if (!health || (!authBlocked && !connectivity)) return null;

  const details = [health.message, health.stderr].filter((s) => !!s && s.trim()).join('\n\n');

  if (connectivity) {
    return (
      <div className="context-auth-banner context-auth-banner-quiet" role="status" aria-live="polite">
        <div className="context-auth-banner-row">
          <span className="context-auth-banner-title">
            {healthKindLabel(health.kind)}: {context}
          </span>
          {health.message && <span className="context-auth-banner-summary">{health.message}</span>}
          <div className="context-auth-banner-actions">
            <button className="context-auth-btn" onClick={() => void retry()} disabled={retrying}>
              {retrying ? 'Checking…' : 'Retry'}
            </button>
          </div>
        </div>
        {retryError && <div className="context-auth-banner-error">{retryError}</div>}
      </div>
    );
  }

  const plugin = pluginName(health.plugin_command);
  const command = health.suggested_command || '';

  const handleCopy = async () => {
    if (!command) return;
    const ok = await copyText(command);
    if (!ok) return;
    setCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="context-auth-banner" role="alert" aria-live="assertive" data-kind={health.kind}>
      <div className="context-auth-banner-row">
        <span className="context-auth-banner-icon" aria-hidden="true">!</span>
        <div className="context-auth-banner-body">
          <div className="context-auth-banner-title">
            Sign-in required for {context}
            {plugin && <span className="context-auth-banner-plugin"> (via {plugin})</span>}
          </div>
          <div className="context-auth-banner-summary">{authHint(health, plugin)}</div>
          {command && (
            <div className="context-auth-banner-command">
              <code aria-label="Suggested command">{command}</code>
              <button className="context-auth-btn" onClick={() => void handleCopy()} aria-label="Copy command">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          {retryError && <div className="context-auth-banner-error">{retryError}</div>}
          {details && (
            <details className="context-auth-banner-details">
              <summary>Details</summary>
              <pre>{details}</pre>
            </details>
          )}
        </div>
        <div className="context-auth-banner-actions">
          <button className="context-auth-btn context-auth-btn-primary" onClick={() => void retry()} disabled={retrying}>
            {retrying ? 'Checking…' : 'Retry'}
          </button>
        </div>
      </div>
    </div>
  );
}
