import { nextDelay } from '../lib/backoff';

/** Auto-reconnect policy for exec sessions after an unexpected disconnect. */
export const EXEC_RECONNECT_MAX_ATTEMPTS = 5;
export const EXEC_RECONNECT_BASE_MS = 1000;
export const EXEC_RECONNECT_CAP_MS = 15000;
/** A session that stayed open this long counts as healthy again. */
export const EXEC_RECONNECT_STABLE_MS = 10000;
/** WebSocket close code the daemon uses when the shell exits normally. */
export const WS_NORMAL_CLOSURE = 1000;

export type ExecReconnectStatus = 'idle' | 'scheduled' | 'connecting' | 'exhausted';

export interface ExecReconnectState {
  status: ExecReconnectStatus;
  /** Retries used since the last healthy session. */
  attempts: number;
  /** Delay of the currently scheduled retry. */
  delayMs: number;
}

export type ExecReconnectEvent =
  /** The socket closed without the user or a RO/lock gate asking for it. */
  | { type: 'unexpected-close'; code: number; openForMs: number; random?: () => number }
  /** A scheduled retry is starting. */
  | { type: 'attempt' }
  /** The socket opened (attempts are kept until the session proves stable). */
  | { type: 'opened' }
  /** User connected/disconnected, or RO/lock ended the session: stop retrying. */
  | { type: 'reset' };

export const initialExecReconnectState: ExecReconnectState = { status: 'idle', attempts: 0, delayMs: 0 };

export function execReconnectReducer(state: ExecReconnectState, event: ExecReconnectEvent): ExecReconnectState {
  switch (event.type) {
    case 'reset':
      return initialExecReconnectState;
    case 'attempt':
      return state.status === 'scheduled' ? { ...state, status: 'connecting' } : state;
    case 'opened':
      return state.status === 'idle' ? state : { ...state, status: 'idle', delayMs: 0 };
    case 'unexpected-close': {
      // A normal closure means the shell exited (e.g. the user typed `exit`):
      // the session ended on purpose, so do not spawn a new shell.
      if (event.code === WS_NORMAL_CLOSURE) return initialExecReconnectState;
      const attempts = event.openForMs >= EXEC_RECONNECT_STABLE_MS ? 0 : state.attempts;
      if (attempts >= EXEC_RECONNECT_MAX_ATTEMPTS) {
        return { status: 'exhausted', attempts, delayMs: 0 };
      }
      const delayMs = Math.max(
        250,
        nextDelay(attempts, { baseMs: EXEC_RECONNECT_BASE_MS, capMs: EXEC_RECONNECT_CAP_MS, random: event.random }),
      );
      return { status: 'scheduled', attempts: attempts + 1, delayMs };
    }
    default:
      return state;
  }
}
