// @vitest-environment node
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonPortForwardApi } from '../../src/main/portForwardApi';
import { PortForwardApiError } from '../../src/main/portForwardSupervisor';

const TOKEN = 'a'.repeat(64);
let server: http.Server | null = null;

interface Seen {
  method?: string;
  url?: string;
  auth?: string;
  body: string;
}

async function serve(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { seen, api: createDaemonPortForwardApi(() => ({ port, token: TOKEN })) };
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

describe('createDaemonPortForwardApi', () => {
  it('talks to the daemon endpoints with the bearer token', async () => {
    const { seen, api } = await serve((req, _body, res) => {
      if (req.url === '/api/portforward/start') return json(res, 200, { id: 'x', status: 'starting' });
      if (req.url === '/api/portforward') return json(res, 200, { forwards: [{ id: 'x' }] });
      if (req.url?.startsWith('/api/portforward/suggest-port')) return json(res, 200, { port: 5432 });
      return json(res, 404, { error: 'port-forward not found' });
    });

    const started = await api.start({
      context: 'prod', namespace: 'ns', kind: 'pod', name: 'p', remote_port: 'http', local_port: 8080,
    });
    expect(started.id).toBe('x');
    expect(await api.list()).toEqual([{ id: 'x' }]);
    await api.stop('gone'); // 404 is not an error
    expect(await api.suggestPort({ context: 'prod', namespace: 'ns', kind: 'service', name: 'db' })).toBe(5432);

    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/portforward/start' });
    expect(JSON.parse(seen[0].body)).toEqual({
      context: 'prod', namespace: 'ns', kind: 'pod', name: 'p', remote_port: 'http', local_port: 8080,
    });
    expect(seen[1]).toMatchObject({ method: 'GET', url: '/api/portforward' });
    expect(seen[2]).toMatchObject({ method: 'POST', url: '/api/portforward/stop', body: '{"id":"gone"}' });
    expect(seen[3].url).toBe('/api/portforward/suggest-port?context=prod&namespace=ns&kind=service&name=db');
  });

  it('surfaces daemon error messages with the HTTP status', async () => {
    const { api } = await serve((_req, _body, res) => json(res, 409, { error: 'store is locked' }));
    const err = await api
      .start({ context: 'c', namespace: 'ns', kind: 'pod', name: 'p', remote_port: 80, local_port: 1 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PortForwardApiError);
    expect(err.message).toBe('store is locked');
    expect(err.status).toBe(409);
  });

  it('rejects when the daemon is not ready', async () => {
    const api = createDaemonPortForwardApi(() => null);
    await expect(api.list()).rejects.toThrow(/not ready/);
  });
});
