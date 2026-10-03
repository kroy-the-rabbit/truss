import { describe, expect, test } from 'vitest';
import {
  EXEC_RECONNECT_MAX_ATTEMPTS,
  EXEC_RECONNECT_STABLE_MS,
  execReconnectReducer,
  initialExecReconnectState,
  type ExecReconnectState,
} from '../../src/renderer/components/execReconnect';

const drop = (openForMs = 0, code = 1006) => ({
  type: 'unexpected-close' as const,
  code,
  openForMs,
  random: () => 0.5,
});

describe('execReconnectReducer', () => {
  test('an unexpected close schedules a reconnect with growing delays', () => {
    let s = execReconnectReducer(initialExecReconnectState, drop());
    expect(s).toEqual({ status: 'scheduled', attempts: 1, delayMs: 500 });
    s = execReconnectReducer(s, { type: 'attempt' });
    expect(s.status).toBe('connecting');
    s = execReconnectReducer(s, drop());
    expect(s).toEqual({ status: 'scheduled', attempts: 2, delayMs: 1000 });
  });

  test(`gives up after ${EXEC_RECONNECT_MAX_ATTEMPTS} attempts`, () => {
    let s: ExecReconnectState = initialExecReconnectState;
    for (let i = 0; i < EXEC_RECONNECT_MAX_ATTEMPTS; i++) {
      s = execReconnectReducer(s, drop());
      expect(s.status).toBe('scheduled');
      s = execReconnectReducer(s, { type: 'attempt' });
    }
    s = execReconnectReducer(s, drop());
    expect(s.status).toBe('exhausted');
    expect(s.attempts).toBe(EXEC_RECONNECT_MAX_ATTEMPTS);
    // A manual Reconnect starts over.
    s = execReconnectReducer(s, { type: 'reset' });
    expect(s).toEqual(initialExecReconnectState);
  });

  test('an open-then-immediately-dropped session keeps counting attempts', () => {
    let s = execReconnectReducer(initialExecReconnectState, drop());
    s = execReconnectReducer(s, { type: 'attempt' });
    s = execReconnectReducer(s, { type: 'opened' });
    expect(s.status).toBe('idle');
    expect(s.attempts).toBe(1);
    s = execReconnectReducer(s, drop(100));
    expect(s.attempts).toBe(2);
  });

  test('a session that was stable before dropping starts from attempt 0', () => {
    let s: ExecReconnectState = { status: 'idle', attempts: 4, delayMs: 0 };
    s = execReconnectReducer(s, drop(EXEC_RECONNECT_STABLE_MS));
    expect(s).toEqual({ status: 'scheduled', attempts: 1, delayMs: 500 });
  });

  test('a normal closure (shell exited) does not reconnect', () => {
    const s = execReconnectReducer({ status: 'idle', attempts: 2, delayMs: 0 }, drop(0, 1000));
    expect(s).toEqual(initialExecReconnectState);
  });

  test('reset (manual close, RO, vault lock) cancels a scheduled reconnect', () => {
    const s = execReconnectReducer(execReconnectReducer(initialExecReconnectState, drop()), { type: 'reset' });
    expect(s.status).toBe('idle');
    expect(s.attempts).toBe(0);
  });
});
