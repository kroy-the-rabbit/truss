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
  | 'EXEC_APPROVAL_REQUIRED'
  | '';

/** What a context's kubeconfig runs or reads on this computer (from the daemon). */
export interface SensitiveAuth {
  exec?: {
    command: string;
    args: string[];
    env_names: string[];
    api_version?: string;
    interactive_mode?: string;
    command_line: string;
  };
  auth_provider?: string;
  file_refs?: { field: string; path: string }[];
  fingerprint: string;
}

export interface ContextHealth {
  context: string;
  state: ContextHealthState;
  kind: ContextHealthKind;
  message?: string;
  plugin_command?: string;
  suggested_command?: string;
  stderr?: string;
  since?: string;
  sensitive?: SensitiveAuth | null;
}

export function contextHealthQueryKey(context: string) {
  return ['contextHealth', context] as const;
}

export function isAuthKind(kind: string | undefined | null): boolean {
  return typeof kind === 'string' && (kind.startsWith('AUTH_') || kind === 'EXEC_APPROVAL_REQUIRED');
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
  EXEC_APPROVAL_REQUIRED: 'Approval required',
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

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function normalizeSensitive(raw: unknown): SensitiveAuth | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.fingerprint !== 'string' || !r.fingerprint) return null;
  const out: SensitiveAuth = { fingerprint: r.fingerprint };
  const ex = r.exec as Record<string, unknown> | undefined;
  if (ex && typeof ex === 'object' && typeof ex.command === 'string') {
    out.exec = {
      command: ex.command,
      args: strings(ex.args),
      env_names: strings(ex.env_names),
      api_version: typeof ex.api_version === 'string' ? ex.api_version : '',
      interactive_mode: typeof ex.interactive_mode === 'string' ? ex.interactive_mode : '',
      command_line: typeof ex.command_line === 'string' ? ex.command_line : [ex.command, ...strings(ex.args)].join(' '),
    };
  }
  if (typeof r.auth_provider === 'string' && r.auth_provider) out.auth_provider = r.auth_provider;
  if (Array.isArray(r.file_refs)) {
    out.file_refs = r.file_refs
      .filter((f): f is { field: string; path: string } =>
        !!f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string')
      .map((f) => ({ field: String(f.field ?? ''), path: f.path }));
  }
  return out;
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
    sensitive: normalizeSensitive(r.sensitive),
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
        prev.plugin_command === health.plugin_command &&
        prev.sensitive?.fingerprint === health.sensitive?.fingerprint
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

async function postHealthAction(path: string, body: unknown, context: string, what: string): Promise<ContextHealth> {
  const resp = await fetchSetupAPI(path, { method: 'POST', body: JSON.stringify(body) });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = (data as { error?: string } | null)?.error;
    throw new Error(err || `${what} failed (HTTP ${resp.status})`);
  }
  return normalizeHealth(data, context);
}

/** Approve the exact exec/auth configuration identified by `fingerprint`, then probe the cluster. */
export function postApproveExec(context: string, fingerprint: string): Promise<ContextHealth> {
  return postHealthAction('/api/contexts/approve-exec', { context, fingerprint }, context, 'Approval');
}

/** Withdraw approval: Truss stops running the context's command until approved again. */
export function postRevokeExec(context: string): Promise<ContextHealth> {
  return postHealthAction('/api/contexts/revoke-exec', { context }, context, 'Revoke');
}

export interface ExecApprovalItem {
  name: string;
  approved: boolean;
  sensitive: SensitiveAuth;
}

/** Stored contexts (active profile) that run a command or read local files. */
export async function fetchExecApprovals(): Promise<ExecApprovalItem[]> {
  const resp = await fetchSetupAPI('/api/contexts/exec-approvals');
  if (!resp.ok) return [];
  const body = (await resp.json().catch(() => null)) as { contexts?: unknown[] } | null;
  const out: ExecApprovalItem[] = [];
  for (const raw of body?.contexts ?? []) {
    const r = (raw ?? {}) as { name?: unknown; approved?: unknown; sensitive?: unknown };
    const sensitive = normalizeSensitive(r.sensitive);
    if (typeof r.name === 'string' && sensitive) out.push({ name: r.name, approved: r.approved === true, sensitive });
  }
  return out;
}

/** Contexts from a POST /api/contexts/import response that need approval before Truss connects. */
export function pendingApprovalsFromImport(body: unknown): { name: string; sensitive: SensitiveAuth }[] {
  const contexts = (body as { contexts?: unknown[] } | null)?.contexts;
  if (!Array.isArray(contexts)) return [];
  const out: { name: string; sensitive: SensitiveAuth }[] = [];
  for (const raw of contexts) {
    const r = (raw ?? {}) as { name?: unknown; requires_approval?: unknown; sensitive?: unknown };
    const sensitive = normalizeSensitive(r.sensitive);
    if (r.requires_approval === true && typeof r.name === 'string' && sensitive) out.push({ name: r.name, sensitive });
  }
  return out;
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
