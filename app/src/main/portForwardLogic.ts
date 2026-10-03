// Pure port-forward decision logic (no Electron / child_process imports) so it
// can be unit tested.

export const PORT_FORWARD_MAX_RESTARTS = 5;

export type PortForwardStderrKind =
  /** Per-connection failure; kubectl keeps listening. Not fatal. */
  | 'connection-error'
  /** The pod stream died; kubectl will exit (or is about to be useless). */
  | 'lost-connection'
  | 'other';

export function classifyPortForwardStderr(line: string): PortForwardStderrKind {
  const lower = line.toLowerCase();
  if (lower.includes('lost connection to pod')) return 'lost-connection';
  if (
    lower.includes('error occurred forwarding') ||
    lower.includes('an error occurred forwarding') ||
    lower.includes('error copying from') ||
    lower.includes('connection reset by peer') ||
    lower.includes('broken pipe')
  ) {
    return 'connection-error';
  }
  return 'other';
}

export interface PortForwardSpec {
  context: string;
  namespace: string;
  targetType: 'pod' | 'service';
  targetName: string;
  localPort: number;
  targetPort: number | string;
}

export interface PortForwardLiveness extends PortForwardSpec {
  /** User still wants this forward (not stopped by user / lock). */
  wanted: boolean;
  /** A restart is scheduled (no process right now, but one is coming). */
  restartPending: boolean;
  proc?: { exitCode: number | null; signalCode: NodeJS.Signals | string | null } | undefined;
}

export function hasLiveProcess(rec: Pick<PortForwardLiveness, 'proc'>): boolean {
  const p = rec.proc;
  return !!p && p.exitCode === null && p.signalCode === null;
}

/** A record occupies its local port if kubectl is running or about to be restarted. */
export function occupiesLocalPort(rec: PortForwardLiveness): boolean {
  return hasLiveProcess(rec) || (rec.wanted && rec.restartPending);
}

export function sameTarget(a: PortForwardSpec, b: PortForwardSpec): boolean {
  return (
    a.context === b.context &&
    a.namespace === b.namespace &&
    a.targetType === b.targetType &&
    a.targetName === b.targetName &&
    a.localPort === b.localPort &&
    a.targetPort === b.targetPort
  );
}

export type PortForwardMatch<T> =
  | { kind: 'duplicate'; record: T }
  | { kind: 'port-conflict'; record: T }
  | null;

/**
 * Decide whether a new port-forward request duplicates an existing live one
 * (same target and local port → reuse it) or collides with a different live
 * forward on the same local port.
 */
export function findPortForwardMatch<T extends PortForwardLiveness>(
  records: Iterable<T>,
  spec: PortForwardSpec,
): PortForwardMatch<T> {
  let conflict: T | null = null;
  for (const rec of records) {
    if (!occupiesLocalPort(rec) || rec.localPort !== spec.localPort) continue;
    if (sameTarget(rec, spec)) return { kind: 'duplicate', record: rec };
    conflict = conflict ?? rec;
  }
  return conflict ? { kind: 'port-conflict', record: conflict } : null;
}

export type PortForwardExitDecision = 'stopped' | 'restart' | 'error';

/**
 * What to do when kubectl exits.
 * - user/lock stopped it → stopped (never restart)
 * - it never got to "Forwarding from" on the first launch → error (bad target, port in use…)
 * - otherwise restart until the attempt cap, then error
 */
export function decidePortForwardExit(opts: {
  wanted: boolean;
  everRunning: boolean;
  restartAttempts: number;
  maxRestarts?: number;
}): PortForwardExitDecision {
  if (!opts.wanted) return 'stopped';
  if (!opts.everRunning) return 'error';
  const max = opts.maxRestarts ?? PORT_FORWARD_MAX_RESTARTS;
  return opts.restartAttempts < max ? 'restart' : 'error';
}
