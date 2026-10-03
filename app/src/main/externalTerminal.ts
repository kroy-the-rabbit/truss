/**
 * "Open in system terminal" support.
 *
 * The terminal must talk to the cluster defined in the encrypted vault, not
 * whatever ~/.kube/config happens to contain. The main process fetches a
 * minimal single-context kubeconfig from trussd (main-only endpoint), writes
 * it to a private per-launch file and starts the terminal with
 * KUBECONFIG=<file>. The exported kubeconfig's current-context is the vault
 * context, so no `--context` argument is passed and the context name never
 * appears on any command line.
 *
 * Lifetime: the files are deleted when the vault locks, when the app quits,
 * and stale leftovers (older than 12h, e.g. after a crash) are swept at
 * startup. A terminal opened earlier therefore loses cluster access after a
 * lock or quit; this is intended, as the vault's credentials must not outlive
 * the unlocked session.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

export const STALE_KUBECONFIG_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const KUBECONFIG_FILE_RE = /^kc-[0-9a-f]{32}\.yaml$/;
const RANDOM_DIR_RE = /^truss-kc-[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DNS1123_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS1123_SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** Namespaces and container names are DNS-1123 labels. */
export function isDns1123Label(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 63 && DNS1123_LABEL_RE.test(value);
}

/** Pod names are DNS-1123 subdomains. */
export function isDns1123Subdomain(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && DNS1123_SUBDOMAIN_RE.test(value);
}

export interface TerminalRequest {
  type: 'exec' | 'logs';
  context: string;
  namespace: string;
  pod: string;
  container: string;
  tailLines?: number;
  timestamps?: boolean;
}

/** Validate untrusted renderer input. Throws on anything unexpected. */
export function parseTerminalRequest(opts: unknown): TerminalRequest {
  if (!opts || typeof opts !== 'object') throw new Error('Invalid terminal request');
  const o = opts as Record<string, unknown>;
  const type = o.type === 'exec' ? 'exec' : o.type === 'logs' || o.type === undefined ? 'logs' : null;
  if (!type) throw new Error('Invalid terminal type');
  if (typeof o.context !== 'string' || !o.context.trim()) throw new Error('A vault context is required');
  if (!isDns1123Label(o.namespace)) throw new Error('Invalid namespace');
  if (!isDns1123Subdomain(o.pod)) throw new Error('Invalid pod name');
  if (!isDns1123Label(o.container)) throw new Error('Invalid container name');
  let tailLines: number | undefined;
  if (o.tailLines !== undefined && o.tailLines !== null) {
    if (typeof o.tailLines !== 'number' || !Number.isSafeInteger(o.tailLines) || o.tailLines < 0) {
      throw new Error('Invalid tailLines');
    }
    tailLines = o.tailLines > 0 ? o.tailLines : undefined;
  }
  return {
    type,
    context: o.context,
    namespace: o.namespace,
    pod: o.pod,
    container: o.container,
    tailLines,
    timestamps: o.timestamps === true,
  };
}

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

/** kubectl argv. Contains only fixed tokens and DNS-1123-validated names. */
export function buildKubectlArgs(req: TerminalRequest): string[] {
  if (req.type === 'exec') {
    return [
      'exec', '-it', '-n', req.namespace, req.pod, '-c', req.container,
      '--', '/bin/sh', '-c', 'exec bash 2>/dev/null || exec sh',
    ];
  }
  const args = ['logs', '-f', '-n', req.namespace, req.pod, '-c', req.container];
  if (req.tailLines && req.tailLines > 0) args.push('--tail', String(req.tailLines));
  if (req.timestamps) args.push('--timestamps');
  return args;
}

export function shellEscapePosix(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface TerminalCandidate {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

/**
 * Build the terminal launch candidates (tried in order) for a platform.
 * KUBECONFIG is set in the environment; on POSIX it is also exported inside
 * the shell command because login shells / Terminal.app do not reliably pass
 * the parent environment through. The file path is ours (random name in a
 * private dir) and is POSIX-quoted; nothing else interpolated is untrusted.
 */
export function buildTerminalCandidates(
  platform: NodeJS.Platform,
  req: TerminalRequest,
  kubeconfigPath: string,
  baseEnv: NodeJS.ProcessEnv,
): TerminalCandidate[] {
  const env: NodeJS.ProcessEnv = { ...baseEnv, KUBECONFIG: kubeconfigPath };
  const kubectlArgs = buildKubectlArgs(req);

  if (platform === 'win32') {
    // Every kubectl token is [a-z0-9.-] or a fixed literal; the one argument
    // with spaces/metacharacters is a fixed string inside double quotes,
    // where cmd.exe treats | and > literally. KUBECONFIG is inherited via env.
    const line = ['kubectl', ...kubectlArgs]
      .map((a) => (/^[A-Za-z0-9._/=-]+$/.test(a) ? a : `"${a}"`))
      .join(' ');
    return [{
      cmd: 'cmd.exe',
      args: ['/d', '/c', `start "" cmd /k ${line}`],
      env,
      windowsVerbatimArguments: true,
    }];
  }

  const kubectlLine = ['kubectl', ...kubectlArgs].map(shellEscapePosix).join(' ');
  const shellCmd = `export KUBECONFIG=${shellEscapePosix(kubeconfigPath)}; ${kubectlLine}; exec bash`;

  if (platform === 'darwin') {
    const escaped = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return [{
      cmd: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "${escaped}"`],
      env,
    }];
  }

  return [
    { cmd: 'gnome-terminal', args: ['--', 'bash', '-lc', shellCmd], env },
    { cmd: 'konsole', args: ['-e', 'bash', '-lc', shellCmd], env },
    { cmd: 'xterm', args: ['-e', 'bash', '-lc', shellCmd], env },
  ];
}

// ---------------------------------------------------------------------------
// Private kubeconfig files
// ---------------------------------------------------------------------------

export interface KubeconfigDirOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  tempDir: string;
  uid: number;
}

/**
 * Where per-launch kubeconfigs live.
 * Linux: $XDG_RUNTIME_DIR/truss (fallback <temp>/truss-<uid>), fixed so
 * stale files can be swept. macOS/Windows: a random <temp>/truss-kc-<hex>
 * directory per app launch (per-user temp dirs; Windows relies on their ACLs).
 */
export function resolveKubeconfigDir(o: KubeconfigDirOptions): string {
  if (o.platform === 'linux') {
    const runtime = o.env.XDG_RUNTIME_DIR;
    if (runtime && path.isAbsolute(runtime)) return path.join(runtime, 'truss');
    return path.join(o.tempDir, `truss-${o.uid}`);
  }
  return path.join(o.tempDir, `truss-kc-${crypto.randomBytes(16).toString('hex')}`);
}

/** Directories (besides the current one) that may hold stale files from earlier runs. */
function sweepRoots(o: KubeconfigDirOptions, currentDir: string): string[] {
  if (o.platform === 'linux') return [currentDir];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(o.tempDir);
  } catch {
    return [];
  }
  return entries.filter((e) => RANDOM_DIR_RE.test(e)).map((e) => path.join(o.tempDir, e));
}

function ensurePrivateDir(dir: string, platform: NodeJS.Platform): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`Refusing to use kubeconfig dir ${dir}: not a directory`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`Refusing to use kubeconfig dir ${dir}: owned by another user`);
  }
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

export class KubeconfigFiles {
  private readonly tracked = new Set<string>();
  private dir: string | null = null;

  constructor(private readonly opts: KubeconfigDirOptions) {}

  private currentDir(): string {
    if (!this.dir) this.dir = resolveKubeconfigDir(this.opts);
    return this.dir;
  }

  /** Write a kubeconfig to a fresh random file (dir 0700, file 0600). */
  write(kubeconfigYaml: string): string {
    const dir = this.currentDir();
    ensurePrivateDir(dir, this.opts.platform);
    const file = path.join(dir, `kc-${crypto.randomBytes(16).toString('hex')}.yaml`);
    // 'wx' fails if the path exists (no following a planted symlink).
    const fd = fs.openSync(file, 'wx', 0o600);
    this.tracked.add(file);
    try {
      if (this.opts.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, kubeconfigYaml);
    } finally {
      fs.closeSync(fd);
    }
    return file;
  }

  trackedFiles(): string[] {
    return [...this.tracked];
  }

  /** Delete every file written by this process (vault lock, app quit). */
  cleanupAll(): void {
    for (const file of this.tracked) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Best effort.
      }
    }
    this.tracked.clear();
    if (this.dir && this.opts.platform !== 'linux') {
      try {
        fs.rmdirSync(this.dir);
      } catch {
        // Not empty or already gone.
      }
    }
  }

  /** Remove leftover kubeconfigs older than maxAgeMs from earlier runs. */
  sweepStale(now = Date.now(), maxAgeMs = STALE_KUBECONFIG_MAX_AGE_MS): void {
    for (const root of sweepRoots(this.opts, this.currentDir())) {
      let entries: string[];
      try {
        entries = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!KUBECONFIG_FILE_RE.test(name)) continue;
        const file = path.join(root, name);
        if (this.tracked.has(file)) continue;
        try {
          const st = fs.lstatSync(file);
          if (now - st.mtimeMs > maxAgeMs) fs.rmSync(file, { force: true });
        } catch {
          // Best effort.
        }
      }
      if (root !== this.currentDir()) {
        try {
          fs.rmdirSync(root);
        } catch {
          // Still holds fresh files from another run, or not ours.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon export
// ---------------------------------------------------------------------------

export interface DaemonMainAccess {
  port: number;
  token: string;
  mainToken: string;
}

/** Fetch the vault-scoped kubeconfig for one context from trussd. Never log the result. */
export function fetchVaultKubeconfig(access: DaemonMainAccess, context: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ context });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: access.port,
        path: '/api/contexts/export-kubeconfig',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${access.token}`,
          'X-Truss-Main-Token': access.mainToken,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let parsed: { kubeconfig?: unknown; error?: unknown } = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Fall through to the status-based error.
          }
          if (res.statusCode === 200 && typeof parsed.kubeconfig === 'string' && parsed.kubeconfig) {
            resolve(parsed.kubeconfig);
            return;
          }
          const msg = typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.statusCode}`;
          reject(new Error(`Could not export kubeconfig: ${msg}`));
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Kubeconfig export timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface OpenTerminalDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isLocked: () => boolean;
  getAccess: () => DaemonMainAccess | null;
  files: Pick<KubeconfigFiles, 'write'>;
  fetchKubeconfig?: typeof fetchVaultKubeconfig;
  launch: (candidates: TerminalCandidate[]) => void;
  removeFile?: (file: string) => void;
}

export async function openExternalTerminal(opts: unknown, deps: OpenTerminalDeps): Promise<{ ok: true }> {
  if (deps.isLocked()) throw new Error('Store is locked');
  const req = parseTerminalRequest(opts);
  const access = deps.getAccess();
  if (!access) throw new Error('Daemon is not ready');
  const kubeconfig = await (deps.fetchKubeconfig ?? fetchVaultKubeconfig)(access, req.context);
  // The vault may have locked while the export was in flight.
  if (deps.isLocked()) throw new Error('Store is locked');
  const file = deps.files.write(kubeconfig);
  if (deps.isLocked()) {
    (deps.removeFile ?? ((f: string) => fs.rmSync(f, { force: true })))(file);
    throw new Error('Store is locked');
  }
  deps.launch(buildTerminalCandidates(deps.platform, req, file, deps.env));
  return { ok: true };
}
