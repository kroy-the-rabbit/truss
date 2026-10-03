// Pure port-forward decision logic (no Electron / Node imports) so it can be
// unit tested. Forwards run inside trussd; main only supervises them.

export const PORT_FORWARD_MAX_RESTARTS = 5;

export type PortForwardStatus = 'starting' | 'running' | 'stopped' | 'error';

export interface PortForwardSpec {
  context: string;
  namespace: string;
  targetType: 'pod' | 'service';
  targetName: string;
  localPort: number;
  targetPort: number | string;
}

export interface PortForwardLiveness extends PortForwardSpec {
  status: PortForwardStatus;
  /** User still wants this forward (not stopped by user / lock). */
  wanted: boolean;
  /** A restart is scheduled (nothing running right now, but one is coming). */
  restartPending: boolean;
}

/** A record occupies its local port while it is (or is about to be) forwarding. */
export function occupiesLocalPort(rec: PortForwardLiveness): boolean {
  if (!rec.wanted) return false;
  return rec.status === 'running' || rec.status === 'starting' || rec.restartPending;
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

export type PortForwardFailureDecision = 'stopped' | 'restart' | 'error';

/**
 * What to do when the daemon reports a forward failed.
 * - user/lock stopped it → stopped (never restart)
 * - it never reached "running" → error (bad target, RBAC…)
 * - otherwise restart until the attempt cap, then error
 */
export function decidePortForwardExit(opts: {
  wanted: boolean;
  everRunning: boolean;
  restartAttempts: number;
  maxRestarts?: number;
}): PortForwardFailureDecision {
  if (!opts.wanted) return 'stopped';
  if (!opts.everRunning) return 'error';
  const max = opts.maxRestarts ?? PORT_FORWARD_MAX_RESTARTS;
  return opts.restartAttempts < max ? 'restart' : 'error';
}

/** Turn a daemon error string into a user-facing hint where we know one. */
export function derivePortForwardMessage(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('connection refused')) {
    return 'Target port is not listening in the workload. Verify target port or use the Service target.';
  }
  if (lower.includes('address already in use')) {
    return 'Local port is already in use. Pick a different local port.';
  }
  if (lower.includes('forbidden')) {
    return 'Kubernetes API denied port-forward. Check RBAC permissions.';
  }
  if (lower.includes('lost connection to pod')) {
    return 'Connection to pod was lost. Pod may have restarted or is unreachable.';
  }
  return error;
}

export function normalizePortForwardTargetPort(value: unknown): number | string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && value <= 65535 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
  }
  if (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}
