import { describe, expect, it } from 'vitest';
import {
  classifyPortForwardStderr,
  decidePortForwardExit,
  findPortForwardMatch,
  PortForwardLiveness,
} from '../../src/main/portForwardLogic';

const alive = { exitCode: null, signalCode: null };
const dead = { exitCode: 1, signalCode: null };

function rec(over: Partial<PortForwardLiveness> = {}): PortForwardLiveness & { id: string } {
  return {
    id: 'a',
    context: 'ctx',
    namespace: 'ns',
    targetType: 'service',
    targetName: 'web',
    localPort: 8080,
    targetPort: 80,
    wanted: true,
    restartPending: false,
    proc: alive,
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

describe('classifyPortForwardStderr', () => {
  it('treats per-connection forwarding errors as non-fatal', () => {
    expect(
      classifyPortForwardStderr(
        'E0101 12:00:00.000 portforward.go:409] an error occurred forwarding 8080 -> 80: error forwarding port 80 to pod abc: connection refused',
      ),
    ).toBe('connection-error');
    expect(classifyPortForwardStderr('Handling connection for 8080: read: connection reset by peer')).toBe(
      'connection-error',
    );
  });

  it('recognises lost pod connections', () => {
    expect(classifyPortForwardStderr('error: lost connection to pod')).toBe('lost-connection');
  });

  it('other output is "other"', () => {
    expect(classifyPortForwardStderr('Unable to listen on port 8080: address already in use')).toBe('other');
  });
});

describe('findPortForwardMatch', () => {
  it('returns duplicate for a live record with same target, even if its status was error', () => {
    const r = rec();
    expect(findPortForwardMatch([r], spec)).toEqual({ kind: 'duplicate', record: r });
  });

  it('treats a record awaiting restart as occupying the port', () => {
    const r = rec({ proc: undefined, restartPending: true });
    expect(findPortForwardMatch([r], spec)?.kind).toBe('duplicate');
  });

  it('ignores dead records', () => {
    expect(findPortForwardMatch([rec({ proc: dead }), rec({ proc: undefined })], spec)).toBeNull();
    expect(findPortForwardMatch([rec({ proc: undefined, restartPending: true, wanted: false })], spec)).toBeNull();
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

  it('errors without retry when the first launch never forwarded', () => {
    expect(decidePortForwardExit({ wanted: true, everRunning: false, restartAttempts: 0 })).toBe('error');
  });

  it('restarts up to 5 times then errors', () => {
    for (let i = 0; i < 5; i++) {
      expect(decidePortForwardExit({ wanted: true, everRunning: true, restartAttempts: i })).toBe('restart');
    }
    expect(decidePortForwardExit({ wanted: true, everRunning: true, restartAttempts: 5 })).toBe('error');
  });
});
