import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonForward,
  DaemonForwardRequest,
  PortForwardApi,
  PortForwardApiError,
  PortForwardSupervisor,
} from '../../src/main/portForwardSupervisor';

/** In-memory stand-in for trussd's /api/portforward endpoints. */
class FakeDaemon implements PortForwardApi {
  epoch = 1;
  forwards = new Map<string, DaemonForward>();
  startCalls: DaemonForwardRequest[] = [];
  stopCalls: string[] = [];
  startErrors: Error[] = [];
  initialStatus: 'running' | 'starting' = 'running';
  activeContext = 'prod';
  private n = 0;

  async start(req: DaemonForwardRequest): Promise<DaemonForward> {
    this.startCalls.push(req);
    const err = this.startErrors.shift();
    if (err) throw err;
    this.n += 1;
    const f: DaemonForward = {
      id: `d${this.epoch}-${this.n}`,
      context: req.context || this.activeContext,
      namespace: req.namespace,
      kind: req.kind,
      name: req.name,
      remote_port: req.remote_port,
      pod: `${req.name}-pod`,
      pod_port: typeof req.remote_port === 'number' ? req.remote_port : 8080,
      address: '127.0.0.1',
      local_port: req.local_port,
      status: this.initialStatus,
      connections: 0,
      total_connections: 0,
      started_at: new Date().toISOString(),
    };
    this.forwards.set(f.id, f);
    return { ...f };
  }

  async stop(id: string): Promise<void> {
    this.stopCalls.push(id);
    this.forwards.delete(id);
  }

  async list(): Promise<DaemonForward[]> {
    return Array.from(this.forwards.values()).map((f) => ({ ...f }));
  }

  breakAll(reason: string): void {
    for (const f of this.forwards.values()) {
      f.status = 'error';
      f.last_error = reason;
    }
  }

  /** Simulate trussd being restarted by the supervisor: forwards are gone. */
  restart(): void {
    this.forwards.clear();
    this.epoch += 1;
  }
}

const spec = {
  context: 'prod',
  namespace: 'ns',
  targetType: 'service' as const,
  targetName: 'web',
  localPort: 8080,
  targetPort: 80,
};

let daemon: FakeDaemon;
let sup: PortForwardSupervisor;

beforeEach(() => {
  vi.useFakeTimers();
  daemon = new FakeDaemon();
  sup = new PortForwardSupervisor({
    api: daemon,
    getEpoch: () => daemon.epoch,
    pollIntervalMs: 1500,
    random: () => 1, // deterministic backoff: 500, 1000, 2000, ...
  });
});

afterEach(() => {
  sup.shutdown();
  vi.useRealTimers();
});

/** Let one poll run and its async work settle. */
async function tickPoll() {
  await vi.advanceTimersByTimeAsync(1500);
}

describe('PortForwardSupervisor', () => {
  it('starts forwards in the daemon with the renderer spec mapped to the API', async () => {
    const view = await sup.start(spec);
    expect(daemon.startCalls).toEqual([
      { context: 'prod', namespace: 'ns', kind: 'service', name: 'web', remote_port: 80, local_port: 8080 },
    ]);
    expect(view.status).toBe('running');
    expect(view.message).toBe('Forwarding');
    expect(view.pod).toBe('web-pod');
    expect(sup.list().map((r) => r.id)).toEqual([view.id]);
  });

  it('dedupes identical requests and rejects local port conflicts', async () => {
    const a = await sup.start(spec);
    const b = await sup.start({ ...spec });
    expect(b.id).toBe(a.id);
    expect(daemon.startCalls).toHaveLength(1);
    await expect(sup.start({ ...spec, targetName: 'api' })).rejects.toThrow(/already used/);
  });

  it('throws initial start errors and keeps no record', async () => {
    daemon.startErrors.push(new PortForwardApiError('service ns/web has no ready pods', 400));
    await expect(sup.start(spec)).rejects.toThrow('service ns/web has no ready pods');
    expect(sup.list()).toEqual([]);
  });

  it('restarts a running forward that breaks, with backoff, up to 5 times', async () => {
    const { id } = await sup.start(spec);
    for (let attempt = 1; attempt <= 5; attempt++) {
      daemon.breakAll('lost connection to pod ns/web-pod');
      await tickPoll();
      const v = sup.get(id)!;
      expect(v.status).toBe('starting');
      expect(v.message).toBe(`Reconnecting (attempt ${attempt}/5)`);
      // Broken daemon forward is cleaned up; restart waits for the backoff.
      expect(daemon.forwards.size).toBe(0);
      const callsBefore = daemon.startCalls.length;
      const delay = 500 * 2 ** (attempt - 1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(daemon.startCalls.length).toBe(callsBefore);
      await vi.advanceTimersByTimeAsync(1);
      expect(daemon.startCalls.length).toBe(callsBefore + 1);
      expect(sup.get(id)!.status).toBe('running');
      expect(sup.get(id)!.message).toBe('Forwarding (reconnected)');
    }
    daemon.breakAll('lost connection to pod ns/web-pod');
    await tickPoll();
    const v = sup.get(id)!;
    expect(v.status).toBe('error');
    expect(v.message).toMatch(/Connection to pod was lost/);
    const calls = daemon.startCalls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(daemon.startCalls.length).toBe(calls);
  });

  it('does not restart a forward that never reached running', async () => {
    daemon.initialStatus = 'starting';
    const { id } = await sup.start(spec);
    daemon.breakAll('pods "web-pod" is forbidden');
    await tickPoll();
    expect(sup.get(id)!.status).toBe('error');
    expect(sup.get(id)!.message).toMatch(/RBAC/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.startCalls).toHaveLength(1);
  });

  it('re-starts wanted forwards when the daemon epoch changes', async () => {
    const keep = await sup.start(spec);
    const dropped = await sup.start({ ...spec, localPort: 9090 });
    await sup.stop(dropped.id);

    daemon.restart();
    sup.onDaemonState({ status: 'restarting', epoch: 1 });
    expect(daemon.startCalls).toHaveLength(2);
    sup.onDaemonState({ status: 'ready', epoch: daemon.epoch });
    await vi.advanceTimersByTimeAsync(0);

    expect(daemon.startCalls).toHaveLength(3);
    expect(daemon.startCalls[2].local_port).toBe(8080);
    expect(sup.get(keep.id)!.status).toBe('running');
    expect(sup.get(keep.id)!.output).toMatch(/Daemon restarted/);
    expect(sup.get(dropped.id)!.status).toBe('stopped');
    // Polling now tracks the new daemon's forward.
    daemon.breakAll('lost connection to pod ns/web-pod');
    await tickPoll();
    expect(sup.get(keep.id)!.message).toBe('Reconnecting (attempt 1/5)');
  });

  it('waits for unlock when a restarted daemon is locked', async () => {
    const { id } = await sup.start(spec);
    daemon.restart();
    daemon.startErrors.push(new PortForwardApiError('store is locked', 409));
    sup.onDaemonState({ status: 'ready', epoch: daemon.epoch });
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.get(id)!.message).toMatch(/unlocked/);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(daemon.startCalls).toHaveLength(2);
    sup.unlock();
    await vi.advanceTimersByTimeAsync(0);
    expect(daemon.startCalls).toHaveLength(3);
    expect(sup.get(id)!.status).toBe('running');
  });

  it('never restarts a forward the user stopped', async () => {
    const { id } = await sup.start(spec);
    const daemonId = Array.from(daemon.forwards.keys())[0];
    expect(await sup.stop(id)).toBe(true);
    expect(daemon.stopCalls).toEqual([daemonId]);
    expect(sup.get(id)!.status).toBe('stopped');

    daemon.restart();
    sup.onDaemonState({ status: 'ready', epoch: daemon.epoch });
    sup.resume();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(daemon.startCalls).toHaveLength(1);
    expect(sup.get(id)!.status).toBe('stopped');
  });

  it('cancels a pending restart when the user stops', async () => {
    const { id } = await sup.start(spec);
    daemon.breakAll('lost connection to pod ns/web-pod');
    await tickPoll();
    expect(sup.get(id)!.message).toMatch(/Reconnecting/);
    await sup.stop(id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.startCalls).toHaveLength(1);
  });

  it('lock stops every forward and nothing comes back', async () => {
    const a = await sup.start(spec);
    const b = await sup.start({ ...spec, localPort: 9090, targetName: 'api' });
    sup.lock();
    await vi.advanceTimersByTimeAsync(0);
    for (const id of [a.id, b.id]) {
      expect(sup.get(id)!.status).toBe('stopped');
      expect(sup.get(id)!.message).toBe('Stopped: store locked');
    }
    expect(daemon.forwards.size).toBe(0);
    await expect(sup.start({ ...spec, localPort: 7070 })).rejects.toThrow(/locked/);

    daemon.restart();
    sup.onDaemonState({ status: 'ready', epoch: daemon.epoch });
    sup.unlock();
    sup.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.startCalls).toHaveLength(2);
  });

  it('marks forwards the daemon dropped on its own as stopped', async () => {
    const { id } = await sup.start(spec);
    daemon.forwards.clear(); // e.g. daemon-side profile switch
    await tickPoll();
    expect(sup.get(id)!.status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.startCalls).toHaveLength(1);
  });

  it('resume revives a forward that gave up after running', async () => {
    const { id } = await sup.start(spec);
    // Exhaust the restart budget.
    for (let i = 0; i < 6; i++) {
      daemon.breakAll('lost connection to pod ns/web-pod');
      await tickPoll();
      await vi.advanceTimersByTimeAsync(500 * 2 ** i);
    }
    expect(sup.get(id)!.status).toBe('error');
    const calls = daemon.startCalls.length;
    sup.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(daemon.startCalls.length).toBe(calls + 1);
    expect(sup.get(id)!.status).toBe('running');
  });

  it('pins the resolved context so restarts never follow a changed active context', async () => {
    const { id } = await sup.start({ ...spec, context: '' });
    expect(daemon.startCalls[0].context).toBe('');
    daemon.activeContext = 'staging';
    daemon.breakAll('lost connection to pod ns/web-pod');
    await tickPoll();
    await vi.advanceTimersByTimeAsync(500);
    expect(daemon.startCalls[1].context).toBe('prod');
    expect(sup.get(id)!.status).toBe('running');
  });

  it('reports live connection counts and per-connection errors from the daemon', async () => {
    const { id } = await sup.start(spec);
    const f = Array.from(daemon.forwards.values())[0];
    f.connections = 2;
    f.connection_error = 'error forwarding port 80 to pod web-pod: connect: connection refused';
    await tickPoll();
    const v = sup.get(id)!;
    expect(v.status).toBe('running');
    expect(v.connections).toBe(2);
    expect(v.output).toMatch(/connection refused/);
  });
});
