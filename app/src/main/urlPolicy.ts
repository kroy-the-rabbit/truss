// Pure URL policy helpers for the Electron main process. Kept free of any
// `electron` imports so they can be unit tested in plain Node.

/** Must stay identical to the CSP <meta> tag in app/index.html (enforced by a unit test). */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; worker-src 'self' blob:";

export interface AppUrlSpec {
  /** Dev mode: the Vite dev server URL (e.g. http://localhost:5173/). Any URL on its origin is the app. */
  devServerUrl?: string;
  /** Packaged mode: file:// URL of the renderer index.html. Only that file (any query/hash) is the app. */
  indexFileUrl?: string;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function normalizeFilePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the raw pathname
  }
  // Windows drive letters may differ in case between Chromium and Node.
  if (/^\/[A-Za-z]:/.test(p)) p = p.toLowerCase();
  return p;
}

/** True when `target` is the Truss renderer itself (same rule for navigation and IPC sender checks). */
export function isAppUrl(target: string | null | undefined, spec: AppUrlSpec): boolean {
  if (!target) return false;
  const url = parse(target);
  if (!url) return false;

  if (spec.devServerUrl) {
    const dev = parse(spec.devServerUrl);
    if (!dev) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin === dev.origin;
  }

  if (spec.indexFileUrl) {
    const index = parse(spec.indexFileUrl);
    if (!index || index.protocol !== 'file:') return false;
    if (url.protocol !== 'file:') return false;
    if (url.host !== index.host) return false;
    return normalizeFilePath(url.pathname) === normalizeFilePath(index.pathname);
  }

  return false;
}

/** True for URLs that may be handed to the system browser via shell.openExternal. */
export function isExternalHttpUrl(target: string | null | undefined): boolean {
  if (!target) return false;
  const url = parse(target);
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:');
}
