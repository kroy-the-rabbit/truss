import { spawn } from 'child_process';

/**
 * Login-shell environment import for the daemon.
 *
 * GUI launches (Finder, .desktop files) do not source the user's shell rc
 * files, so exec credential plugins (gcloud, aws, az, kubelogin) can be
 * missing from PATH or lack their configuration variables. We run the login
 * shell once, read `env -0`, and merge only PATH plus a small allowlist.
 */

const ALLOWED_PREFIXES = ['AWS_', 'CLOUDSDK_', 'AZURE_'];
const ALLOWED_EXACT = new Set(['GOOGLE_APPLICATION_CREDENTIALS', 'KUBECACHEDIR']);
const ALLOWED_CASE_INSENSITIVE = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SHELL_ENV_TIMEOUT_MS = 3000;

export function isAllowedShellEnvKey(key: string): boolean {
  if (ALLOWED_EXACT.has(key)) return true;
  if (ALLOWED_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length)) return true;
  return ALLOWED_CASE_INSENSITIVE.has(key.toUpperCase());
}

/**
 * Parse NUL-delimited `env -0` output. Interactive shells may print banners
 * before the env dump; any text before the last newline in a key is dropped.
 */
export function parseNullDelimitedEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of output.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    let key = entry.slice(0, eq);
    const nl = key.lastIndexOf('\n');
    if (nl >= 0) key = key.slice(nl + 1);
    if (!VALID_KEY.test(key)) continue;
    env[key] = entry.slice(eq + 1);
  }
  return env;
}

function splitPath(value: string | undefined, delimiter: string): string[] {
  return (value || '').split(delimiter).filter(Boolean);
}

/**
 * Merge the login-shell environment into the daemon's base environment.
 *
 * - PATH: shell PATH dirs first, then the already-enriched PATH, deduped.
 * - Allowlisted vars from the shell are added only when the base env does not
 *   already set them (an explicit value from the launching process wins).
 * - Nothing else from the shell is passed through.
 */
export function mergeShellEnv(
  baseEnv: NodeJS.ProcessEnv,
  shellEnv: Record<string, string> | null | undefined,
  enrichedPath: string,
  delimiter = ':',
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv };
  const shell = shellEnv || {};

  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [...splitPath(shell.PATH, delimiter), ...splitPath(enrichedPath, delimiter)]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  merged.PATH = dirs.join(delimiter);

  for (const [key, value] of Object.entries(shell)) {
    if (key === 'PATH' || !isAllowedShellEnvKey(key)) continue;
    if (merged[key] !== undefined && merged[key] !== '') continue;
    merged[key] = value;
  }
  return merged;
}

function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

/**
 * Run `$SHELL -ilc 'env -0'` and return its environment, or null on any
 * failure/timeout. macOS and Linux only.
 */
export function readLoginShellEnv(timeoutMs = SHELL_ENV_TIMEOUT_MS): Promise<Record<string, string> | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(defaultShell(), ['-ilc', 'env -0'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // Keep common rc frameworks from doing slow interactive work.
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true' },
        detached: false,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', () => finish(null));
    child.on('close', () => {
      const out = Buffer.concat(chunks).toString('utf8');
      const env = parseNullDelimitedEnv(out);
      finish(Object.keys(env).length > 0 ? env : null);
    });
  });
}

let cachedShellEnv: Promise<Record<string, string> | null> | null = null;

/** Login-shell env, computed once per app run (daemon restarts reuse it). */
export function getLoginShellEnv(): Promise<Record<string, string> | null> {
  if (!cachedShellEnv) cachedShellEnv = readLoginShellEnv().catch(() => null);
  return cachedShellEnv;
}
