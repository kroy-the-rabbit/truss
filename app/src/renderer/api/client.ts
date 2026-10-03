import { createConnectTransport } from '@connectrpc/connect-web';
import { Code, ConnectError, createPromiseClient } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { DAEMON_READ_ONLY_MESSAGE, READ_ONLY_USER_MESSAGE } from './readOnlyErrors';
import { HealthService } from './gen/truss/v1/health_connect';
import { ContextsService } from './gen/truss/v1/contexts_connect';
import { DiscoveryService } from './gen/truss/v1/discovery_connect';
import { ResourcesService } from './gen/truss/v1/resources_connect';
import { YamlService } from './gen/truss/v1/yaml_connect';
import { HelmService } from './gen/truss/v1/helm_connect';
import { OverviewService } from './gen/truss/v1/overview_connect';

interface DaemonConfig {
  port: number;
  token: string;
}

/** Default deadline for every Connect call that does not set its own. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Calls that legitimately run longer than the default: draining a node waits
 * for evictions, Helm actions may wait for rollouts, and apply/diff can carry
 * large multi-document manifests through server-side dry runs.
 */
export const LONG_RPC_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  DrainNode: 10 * 60_000,
  UpgradeRelease: 10 * 60_000,
  RollbackRelease: 10 * 60_000,
  UninstallRelease: 10 * 60_000,
  ApplyYaml: 2 * 60_000,
  DiffYaml: 2 * 60_000,
};

/** Deadline applied to a unary call whose caller did not pass a timeout. */
export function rpcTimeoutMs(methodName: string): number {
  return LONG_RPC_TIMEOUTS_MS[methodName] ?? DEFAULT_RPC_TIMEOUT_MS;
}

/**
 * Wraps a transport so unary calls get a deadline. Streaming calls are passed
 * through untouched: they are long-lived by design (none exist today).
 */
export function withDefaultTimeouts(inner: Transport): Transport {
  return {
    unary(service, method, signal, timeoutMs, header, input, contextValues) {
      return inner.unary(service, method, signal, timeoutMs ?? rpcTimeoutMs(method.name), header, input, contextValues);
    },
    stream(service, method, signal, timeoutMs, header, input, contextValues) {
      return inner.stream(service, method, signal, timeoutMs, header, input, contextValues);
    },
  };
}

// The transport is bound to the daemon's port and token, which change when the
// daemon restarts. resetTransport() drops it so the next call rebuilds it from
// a fresh getDaemonConfig().
let transportPromise: Promise<Transport> | null = null;

async function getConfig(): Promise<DaemonConfig> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = await (window as any).electronAPI.getDaemonConfig();
  if (!config) {
    throw new Error('Daemon not connected');
  }
  return config;
}

async function buildTransport(): Promise<Transport> {
  const config = await getConfig();
  return withDefaultTimeouts(createConnectTransport({
    baseUrl: `http://127.0.0.1:${config.port}`,
    interceptors: [
      (next) => async (req) => {
        req.header.set('Authorization', `Bearer ${config.token}`);
        try {
          return await next(req);
        } catch (err) {
          // Replace the daemon's terse read-only rejection with a clear message.
          const ce = ConnectError.from(err);
          if (ce.code === Code.PermissionDenied && ce.rawMessage === DAEMON_READ_ONLY_MESSAGE) {
            throw new ConnectError(READ_ONLY_USER_MESSAGE, Code.PermissionDenied);
          }
          throw err;
        }
      },
    ],
  }));
}

function getTransport(): Promise<Transport> {
  if (!transportPromise) {
    const p = buildTransport();
    transportPromise = p;
    // Never cache a failure (daemon not ready yet): the next call retries.
    p.catch(() => {
      if (transportPromise === p) transportPromise = null;
    });
  }
  return transportPromise;
}

export async function getHealthClient() {
  return createPromiseClient(HealthService, await getTransport());
}

export async function getContextsClient() {
  return createPromiseClient(ContextsService, await getTransport());
}

export async function getDiscoveryClient() {
  return createPromiseClient(DiscoveryService, await getTransport());
}

export async function getResourcesClient() {
  return createPromiseClient(ResourcesService, await getTransport());
}

export async function getYamlClient() {
  return createPromiseClient(YamlService, await getTransport());
}

export async function getHelmClient() {
  return createPromiseClient(HelmService, await getTransport());
}

export async function getOverviewClient() {
  return createPromiseClient(OverviewService, await getTransport());
}

/** Drop the cached transport; the next RPC rebuilds it from the current daemon config. */
export function resetTransport() {
  transportPromise = null;
}

// fetchSetupAPI calls a plain REST endpoint on the backend daemon.
// Reads the current port/token on every call, so it follows daemon restarts.
export async function fetchSetupAPI(path: string, options?: RequestInit): Promise<Response> {
  const config = await getConfig();
  const url = `http://127.0.0.1:${config.port}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.token}`,
      ...(options?.headers ?? {}),
    },
  });
}
