import { create } from 'zustand';
import { useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { fetchSetupAPI } from '../api/client';

export type ContextHealthState = 'ok' | 'error' | 'unknown';

export type ContextHealthKind =
  | 'AUTH_REQUIRED'
  | 'AUTH_PLUGIN_MISSING'
  | 'AUTH_INTERACTIVE_UNSUPPORTED'
  | 'AUTH_REJECTED'
  | 'FORBIDDEN'
  | 'UNREACHABLE'
  | 'TLS'
  | 'UNKNOWN'
  | '';

export interface ContextHealth {
  context: string;
  state: ContextHealthState;
  kind: ContextHealthKind;
  message?: string;
  plugin_command?: string;
  suggested_command?: string;
  stderr?: string;
  since?: string;
}

export function contextHealthQueryKey(context: string) {
  return ['contextHealth', context] as const;
}

export function isAuthKind(kind: string | undefined | null): boolean {
  return typeof kind === 'string' && kind.startsWith('AUTH_');
}

/** True when the context is known to need sign-in (state error, kind AUTH_*). */
export function isAuthBlocked(health: ContextHealth | null | undefined): boolean {
  return !!health && health.state === 'error' && isAuthKind(health.kind);
}

/** True when the context is known to be unreachable at the network/TLS layer. */
export function isConnectivityError(health: ContextHealth | null | undefined): boolean {
  return !!health && health.state === 'error' && (health.kind === 'UNREACHABLE' || health.kind === 'TLS');
}

const KIND_LABELS: Record<string, string> = {
  AUTH_REQUIRED: 'Sign-in required',
  AUTH_PLUGIN_MISSING: 'Auth plugin missing',
  AUTH_INTERACTIVE_UNSUPPORTED: 'Sign-in needs a terminal',
  AUTH_REJECTED: 'Credentials rejected',
  FORBIDDEN: 'Access forbidden',
  UNREACHABLE: 'Cluster unreachable',
  TLS: 'TLS error',
  UNKNOWN: 'Context error',
};

export function healthKindLabel(kind: string | undefined | null): string {
  return (kind && KIND_LABELS[kind]) || 'Context unreachable';
}

/** Short executable name of an exec plugin command ("/usr/bin/gke-gcloud-auth-plugin" → "gke-gcloud-auth-plugin"). */
export function pluginName(command: string | undefined | null): string {
  if (!command) return '';
  const first = command.trim().split(/\s+/)[0] || '';
  const parts = first.split(/[\\/]/);
  return parts[parts.length - 1] || first;
}

function normalizeHealth(raw: unknown, context: string): ContextHealth {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ContextHealth>;
  const state: ContextHealthState = r.state === 'ok' || r.state === 'error' ? r.state : 'unknown';
  return {
    context: typeof r.context === 'string' && r.context ? r.context : context,
    state,
    kind: (typeof r.kind === 'string' ? r.kind : '') as ContextHealthKind,
    message: typeof r.message === 'string' ? r.message : '',
    plugin_command: typeof r.plugin_command === 'string' ? r.plugin_command : '',
    suggested_command: typeof r.suggested_command === 'string' ? r.suggested_command : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    since: typeof r.since === 'string' ? r.since : '',
  };
}

function unknownHealth(context: string): ContextHealth {
  return { context, state: 'unknown', kind: '' };
}

// ── Per-context health slice ─────────────────────────────────────────────────

interface ContextHealthStore {
  byContext: Record<string, ContextHealth>;
  setHealth: (health: ContextHealth) => void;
  clear: () => void;
}

export const useContextHealthStore = create<ContextHealthStore>((set) => ({
  byContext: {},
  setHealth: (health) =>
    set((s) => {
      if (!health.context) return s;
      const prev = s.byContext[health.context];
      if (
        prev &&
        prev.state === health.state &&
        prev.kind === health.kind &&
        prev.message === health.message &&
        prev.suggested_command === health.suggested_command &&
        prev.stderr === health.stderr &&
        prev.plugin_command === health.plugin_command
      ) {
        return s;
      }
      return { byContext: { ...s.byContext, [health.context]: health } };
    }),
  clear: () => set({ byContext: {} }),
}));

/**
 * Record a health report from any source (query, reauth, watch socket) so
 * every consumer — banner, TopBar, live watch — sees the same value.
 */
export function recordContextHealth(health: ContextHealth, queryClient?: Pick<QueryClient, 'setQueryData'>) {
  if (!health.context) return;
  useContextHealthStore.getState().setHealth(health);
  queryClient?.setQueryData(contextHealthQueryKey(health.context), health);
}

export function getContextHealth(context: string): ContextHealth | undefined {
  return useContextHealthStore.getState().byContext[context];
}

// ── API calls ───────────────────────────────────────────────────────────────

export async function fetchContextHealth(context: string): Promise<ContextHealth> {
  const resp = await fetchSetupAPI(`/api/context-health?context=${encodeURIComponent(context)}`);
  if (!resp.ok) {
    // Older daemons (404) or transient failures: treat as unknown rather than erroring.
    return unknownHealth(context);
  }
  const body = await resp.json().catch(() => null);
  return normalizeHealth(body, context);
}

export async function postContextReauth(context: string): Promise<ContextHealth> {
  const resp = await fetchSetupAPI('/api/contexts/reauth', {
    method: 'POST',
    body: JSON.stringify({ context }),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = (body as { error?: string } | null)?.error;
    // Some error responses may still carry a ContextHealth payload.
    if (body && typeof body === 'object' && 'state' in body) return normalizeHealth(body, context);
    throw new Error(err || `Re-authentication failed (HTTP ${resp.status})`);
  }
  return normalizeHealth(body, context);
}

// ── Hook ────────────────────────────────────────────────────────────────────

/** Fetches and subscribes to the classified health of one kube context. */
export function useContextHealth(context: string): ContextHealth | undefined {
  useQuery({
    queryKey: contextHealthQueryKey(context),
    queryFn: async () => {
      const health = await fetchContextHealth(context);
      useContextHealthStore.getState().setHealth(health);
      return health;
    },
    enabled: !!context,
    staleTime: 5000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return useContextHealthStore((s) => (context ? s.byContext[context] : undefined));
}
