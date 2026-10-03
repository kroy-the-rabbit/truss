// HTTP client for trussd's port-forward endpoints, using main's own daemon
// config (port + bearer token). Re-reads the config on every call so a
// restarted daemon (new port/token) is picked up automatically.

import http from 'http';
import type { DaemonConfig } from './daemon';
import {
  DaemonForward,
  DaemonForwardRequest,
  PortForwardApi,
  PortForwardApiError,
} from './portForwardSupervisor';

function request<T>(
  getConfig: () => DaemonConfig | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  const cfg = getConfig();
  if (!cfg) return Promise.reject(new PortForwardApiError('Daemon is not ready'));
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: cfg.port,
        path,
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          ...(payload !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = undefined;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            // Non-JSON bodies (e.g. "method not allowed") fall through.
          }
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const msg =
              (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
                ? (parsed as { error: string }).error
                : text.trim()) || `Daemon returned HTTP ${status}`;
            reject(new PortForwardApiError(msg, status));
            return;
          }
          resolve(parsed as T);
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Daemon request timed out after ${timeoutMs}ms`)));
    req.on('error', (err) => reject(new PortForwardApiError(err.message)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function createDaemonPortForwardApi(getConfig: () => DaemonConfig | null): PortForwardApi & {
  suggestPort(opts: { context: string; namespace: string; kind: 'pod' | 'service'; name: string }): Promise<number>;
} {
  return {
    start: (req: DaemonForwardRequest) => request<DaemonForward>(getConfig, 'POST', '/api/portforward/start', req),
    stop: async (id: string) => {
      try {
        await request(getConfig, 'POST', '/api/portforward/stop', { id }, 5000);
      } catch (err) {
        // Already gone is fine.
        if (err instanceof PortForwardApiError && err.status === 404) return;
        throw err;
      }
    },
    list: async () => {
      const res = await request<{ forwards?: DaemonForward[] }>(getConfig, 'GET', '/api/portforward', undefined, 5000);
      return Array.isArray(res?.forwards) ? res.forwards : [];
    },
    suggestPort: async (opts) => {
      const q = new URLSearchParams(opts).toString();
      const res = await request<{ port?: number }>(getConfig, 'GET', `/api/portforward/suggest-port?${q}`, undefined, 7000);
      return typeof res?.port === 'number' ? res.port : 0;
    },
  };
}
