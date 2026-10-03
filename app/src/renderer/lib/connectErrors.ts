import { Code, ConnectError } from '@connectrpc/connect';

/** Returns the Connect error code for err, or null when err is not a ConnectError. */
export function connectErrorCode(err: unknown): Code | null {
  if (err instanceof ConnectError) return err.code;
  // Tolerate errors that crossed a bundle boundary (duck-typed ConnectError).
  if (
    err && typeof err === 'object' &&
    (err as { name?: unknown }).name === 'ConnectError' &&
    typeof (err as { code?: unknown }).code === 'number'
  ) {
    return (err as { code: Code }).code;
  }
  return null;
}

function rawMessage(err: unknown): string {
  if (err instanceof ConnectError) return err.rawMessage;
  if (err && typeof err === 'object' && typeof (err as { rawMessage?: unknown }).rawMessage === 'string') {
    return (err as { rawMessage: string }).rawMessage;
  }
  if (err instanceof Error) return err.message;
  return String(err ?? '');
}

/** True when the daemon refused a mutation because read-only mode is on. */
export function isReadOnlyDenial(err: unknown): boolean {
  return rawMessage(err).toLowerCase().includes('read-only mode');
}

/** True for credential problems (expired login, missing plugin, rejected token). */
export function isAuthError(err: unknown): boolean {
  return connectErrorCode(err) === Code.Unauthenticated;
}

/**
 * True when Kubernetes RBAC denied the request. Checks the Connect code first;
 * falls back to message matching for errors that carry no code.
 */
export function isRbacDeniedError(err: unknown): boolean {
  if (isReadOnlyDenial(err)) return false;
  const code = connectErrorCode(err);
  if (code === Code.PermissionDenied) return true;
  if (code === Code.Unauthenticated || code === Code.Unavailable) return false;
  const lower = rawMessage(err).toLowerCase();
  return lower.includes('forbidden') || lower.includes('permission denied') || lower.includes('rbac');
}

/** A human-readable message for a failed query, without the "[internal]" style prefix. */
export function describeQueryError(err: unknown): string {
  if (isAuthError(err)) {
    return 'Sign-in required for this cluster. See the banner above for how to sign in.';
  }
  const msg = rawMessage(err).trim();
  return msg || 'Unknown error';
}
