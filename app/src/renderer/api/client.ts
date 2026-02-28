import { createConnectTransport } from '@connectrpc/connect-web';
import { createPromiseClient } from '@connectrpc/connect';
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

let transport: ReturnType<typeof createConnectTransport> | null = null;

async function getConfig(): Promise<DaemonConfig> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = await (window as any).electronAPI.getDaemonConfig();
  if (!config) {
    throw new Error('Daemon not connected');
  }
  return config;
}

async function getTransport() {
  if (transport) return transport;

  const config = await getConfig();
  transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${config.port}`,
    interceptors: [
      (next) => async (req) => {
        req.header.set('Authorization', `Bearer ${config.token}`);
        return next(req);
      },
    ],
  });
  return transport;
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

export function resetTransport() {
  transport = null;
}

// fetchSetupAPI calls a plain REST endpoint on the backend daemon.
// Uses the same port/token as the Connect transport.
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
