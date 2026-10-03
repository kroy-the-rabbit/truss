// Main-process client for trussd's plugin secure-storage endpoints.
//
// Renderers never call these endpoints: trussd requires the plugin storage
// main-process token (X-Truss-Main-Token), which only main holds. Main resolves
// the calling plugin from its capability token and injects plugin_id here.

import http from 'http';

export const MAIN_TOKEN_HEADER = 'X-Truss-Main-Token';

export type SecureStorageOp = 'get' | 'set' | 'delete';

export interface SecureStorageTarget {
  port: number;
  token: string; // daemon bearer token
  mainToken: string; // main-process-only daemon token
}

export function pluginSecureStorageRequest(
  target: SecureStorageTarget,
  op: SecureStorageOp,
  body: { plugin_id: string; key: string; value?: unknown },
  timeoutMs = 10000,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path: `/api/plugins/secure-storage/${op}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${target.token}`,
          [MAIN_TOKEN_HEADER]: target.mainToken,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            // Non-JSON error body (e.g. plain-text 400/405).
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('plugin secure storage request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
