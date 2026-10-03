import { Code } from '@connectrpc/connect';
import { QueryCache, QueryClient } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { connectErrorCode } from '../lib/connectErrors';
import { contextHealthQueryKey } from './contextHealth';
import { useAppStore } from './store';

const MAX_RETRIES = 2;
const HEALTH_REFRESH_THROTTLE_MS = 5000;

/**
 * Retry policy shared by every QueryClient: auth and RBAC failures are not
 * transient, so retrying only delays the error (and re-runs exec plugins).
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const code = connectErrorCode(error);
  if (code === Code.Unauthenticated || code === Code.PermissionDenied) return false;
  return failureCount < MAX_RETRIES;
}

function contextForQuery(query: Query<unknown, unknown, unknown, readonly unknown[]>): string {
  const k = query.queryKey as readonly unknown[];
  if (typeof k[1] === 'string' && k[1]) return k[1];
  return useAppStore.getState().activeContext || '';
}

/**
 * Build the QueryCache error hook: when a query fails with Unauthenticated or
 * Unavailable, refresh that context's health so the banner/TopBar update.
 */
export function makeHealthErrorHandler(getClient: () => QueryClient | null) {
  const lastRefresh = new Map<string, number>();
  return (error: unknown, query: Query<unknown, unknown, unknown, readonly unknown[]>) => {
    if ((query.queryKey as readonly unknown[])[0] === 'contextHealth') return;
    const code = connectErrorCode(error);
    if (code !== Code.Unauthenticated && code !== Code.Unavailable) return;
    const context = contextForQuery(query);
    const client = getClient();
    if (!context || !client) return;
    const now = Date.now();
    if (now - (lastRefresh.get(context) ?? 0) < HEALTH_REFRESH_THROTTLE_MS) return;
    lastRefresh.set(context, now);
    void client.invalidateQueries({ queryKey: contextHealthQueryKey(context) }, { cancelRefetch: false });
  };
}

export function createAppQueryClient(): QueryClient {
  let client: QueryClient | null = null;
  client = new QueryClient({
    queryCache: new QueryCache({ onError: makeHealthErrorHandler(() => client) }),
    defaultOptions: {
      queries: {
        staleTime: 10000,
        retry: shouldRetryQuery,
      },
    },
  });
  return client;
}
