import { describe, expect, it } from 'vitest';
import {
  decidePortForwardExit,
  derivePortForwardMessage,
  findPortForwardMatch,
  normalizePortForwardTargetPort,
  PortForwardLiveness,
} from '../../src/main/portForwardLogic';

function rec(over: Partial<PortForwardLiveness> = {}): PortForwardLiveness & { id: string } {
  return {
    id: 'a',
    context: 'ctx',
    namespace: 'ns',
    targetType: 'service',
    targetName: 'web',
    localPort: 8080,
    targetPort: 80,
    status: 'running',
    wanted: true,
    restartPending: false,
    ...over,
  };
}

const spec = {
  context: 'ctx',
  namespace: 'ns',
  targetType: 'service' as const,
  targetName: 'web',
  localPort: 8080,
  targetPort: 80,
};

describe('findPortForwardMatch', () => {
  it('returns duplicate for a live record with the same target', () => {
    const r = rec();
    expect(findPortForwardMatch([r], spec)).toEqual({ kind: 'duplicate', record: r });
    expect(findPortForwardMatch([rec({ status: 'starting' })], spec)?.kind).toBe('duplicate');
  });

  it('treats a record awaiting restart as occupying the port', () => {
    const r = rec({ status: 'error', restartPending: true });
    expect(findPortForwardMatch([r], spec)?.kind).toBe('duplicate');
  });

  it('ignores dead or unwanted records', () => {
    expect(findPortForwardMatch([rec({ status: 'error' }), rec({ status: 'stopped' })], spec)).toBeNull();
    expect(findPortForwardMatch([rec({ restartPending: true, wanted: false })], spec)).toBeNull();
    expect(findPortForwardMatch([rec({ wanted: false })], spec)).toBeNull();
  });

  it('reports a conflict for a different live target on the same local port', () => {
    const other = rec({ targetName: 'api' });
    expect(findPortForwardMatch([other], spec)).toEqual({ kind: 'port-conflict', record: other });
  });

  it('prefers the duplicate over a conflict', () => {
    const other = rec({ id: 'b', targetName: 'api' } as Partial<PortForwardLiveness>);
    const same = rec();
    expect(findPortForwardMatch([other, same], spec)?.kind).toBe('duplicate');
  });

  it('different local port is no match', () => {
    expect(findPortForwardMatch([rec({ localPort: 9090 })], spec)).toBeNull();
  });
});

describe('decidePortForwardExit', () => {
  it('never restarts after user stop', () => {
    expect(decidePortForwardExit({ wanted: false, everRunning: true, restartAttempts: 0 })).toBe('stopped');
  });

  it('errors without retry when the forward never ran', () => {
    expect(decidePortForwardExit({ wanted: true, everRunning: false, restartAttempts: 0 })).toBe('error');
  });

  it('restarts up to 5 times then errors', () => {
    for (let i = 0; i < 5; i++) {
      expect(decidePortForwardExit({ wanted: true, everRunning: true, restartAttempts: i })).toBe('restart');
    }
    expect(decidePortForwardExit({ wanted: true, everRunning: true, restartAttempts: 5 })).toBe('error');
  });
});

describe('derivePortForwardMessage', () => {
  it('maps known daemon errors to hints and passes others through', () => {
    expect(derivePortForwardMessage('error forwarding port 80 to pod p: connect: connection refused')).toMatch(/not listening/);
    expect(derivePortForwardMessage('unable to listen on 127.0.0.1:8080: bind: address already in use')).toMatch(/already in use/);
    expect(derivePortForwardMessage('pods "p" is forbidden: User cannot create pods/portforward')).toMatch(/RBAC/);
    expect(derivePortForwardMessage('lost connection to pod ns/p')).toMatch(/lost/);
    expect(derivePortForwardMessage('service ns/web has no ready pods')).toBe('service ns/web has no ready pods');
  });
});

describe('normalizePortForwardTargetPort', () => {
  it('accepts numbers and port names, rejects junk', () => {
    expect(normalizePortForwardTargetPort(80)).toBe(80);
    expect(normalizePortForwardTargetPort(' 8080 ')).toBe(8080);
    expect(normalizePortForwardTargetPort('http-alt')).toBe('http-alt');
    expect(normalizePortForwardTargetPort(0)).toBeUndefined();
    expect(normalizePortForwardTargetPort(70000)).toBeUndefined();
    expect(normalizePortForwardTargetPort('Bad_Name')).toBeUndefined();
    expect(normalizePortForwardTargetPort(null)).toBeUndefined();
  });
});
