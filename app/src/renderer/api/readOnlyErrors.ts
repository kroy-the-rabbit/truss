// Error text the daemon returns when it rejects a mutation in read-only mode
// (Connect PermissionDenied or HTTP 403 {"error": "..."}).
export const DAEMON_READ_ONLY_MESSAGE = 'read-only mode is enabled';

export const READ_ONLY_USER_MESSAGE =
  'Truss is in read-only (RO) mode. Switch to Write mode to make changes.';

/** True when an error (or error message) is the daemon's read-only rejection. */
export function isReadOnlyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.includes(DAEMON_READ_ONLY_MESSAGE);
}

/** Maps a daemon read-only rejection to a clear message; passes others through. */
export function friendlyErrorMessage(err: unknown): string {
  if (isReadOnlyError(err)) return READ_ONLY_USER_MESSAGE;
  return err instanceof Error ? err.message : String(err ?? '');
}
