import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { app } from 'electron';
import http from 'http';
import { randomBytes } from 'crypto';
import { getLoginShellEnv, mergeShellEnv } from './shellEnv';
import { DaemonHandle, DaemonStatePayload, DaemonSupervisor } from './daemonSupervisor';

export interface DaemonConfig {
  port: number;
  token: string;
}

export interface StartDaemonOptions {
  pathHints?: string[];
}

let supervisor: DaemonSupervisor<DaemonConfig> | null = null;

// Secret for trussd's plugin secure-storage endpoints. Unlike the bearer token
// it is never sent to a renderer, so only main can reach plugin secrets (and
// main injects the caller's bound plugin id). Stable across daemon restarts.
const pluginStorageToken = crypto.randomBytes(32).toString('hex');

export function getPluginStorageToken(): string {
  return pluginStorageToken;
}
// Main-process-only credential per daemon launch, keyed by that launch's
// config object. Deliberately NOT part of DaemonConfig: getDaemonConfig() is
// handed to renderers, and this token must never reach them.
const mainTokens = new WeakMap<DaemonConfig, string>();

function findDaemonBinary(): string {
  const binaryName = process.platform === 'win32' ? 'trussd.exe' : 'trussd';

  if (app.isPackaged) {
    // In production, bundled as extraResource.
    return path.join(process.resourcesPath, 'bin', binaryName);
  }
  // In development, use the build output directly.
  return path.join(__dirname, '..', '..', '..', 'backend', binaryName);
}

/**
 * Desktop apps (Finder on macOS, .desktop launchers on Linux) may inherit a
 * restricted PATH that doesn't include directories where auth plugins live
 * (gke-gcloud-auth-plugin, aws-iam-authenticator, gcloud, helm, etc.).
 * Augment PATH with common tool locations so client-go exec-based credential
 * providers can be found.
 */
export function enrichPath(pathHints: string[] = []): string {
  const current = process.env.PATH || '';
  const delimiter = process.platform === 'win32' ? ';' : ':';

  const home = process.env.HOME || '';
  const platformDefaults = process.platform === 'win32'
    ? []
    : [
        '/usr/local/bin',
        '/usr/local/sbin',
        `${home}/.local/bin`,
        `${home}/bin`,
        `${home}/.krew/bin`,
        `${home}/google-cloud-sdk/bin`,
        ...(process.platform === 'darwin'
          ? [
              '/opt/homebrew/bin',
              '/opt/homebrew/sbin',
              '/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin',
              '/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin',
              '/usr/local/share/google-cloud-sdk/bin',
              '/opt/homebrew/share/google-cloud-sdk/bin',
              '/Library/Google/Cloud SDK/google-cloud-sdk/bin',
            ]
          : ['/snap/bin']),
      ];
  const extra = [...pathHints, ...platformDefaults];

  const existing = new Set(current.split(delimiter).filter(Boolean));
  const additions = extra.filter((p) => p && !existing.has(p));
  if (additions.length === 0) return current;
  if (!current) return additions.join(delimiter);
  return `${current}${delimiter}${additions.join(delimiter)}`;
}

function killWithEscalation(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const t = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore kill failures.
    }
  }, 3000);
  t.unref?.();
}

/** Spawn trussd once and wait until it answers health pings. */
export async function launchDaemon(opts?: StartDaemonOptions): Promise<DaemonHandle<DaemonConfig>> {
  const binary = findDaemonBinary();
  const shellEnv = await getLoginShellEnv();

  return new Promise((resolve, reject) => {
    let settled = false;
    let startupTimer: NodeJS.Timeout | null = null;
    let startupProcess: ChildProcess | null = null;
    const env = mergeShellEnv(
      process.env,
      shellEnv,
      enrichPath(opts?.pathHints || []),
      process.platform === 'win32' ? ';' : ':',
    );
    env.TRUSS_PLUGIN_STORAGE_TOKEN = pluginStorageToken;
    const mainToken = randomBytes(32).toString('hex');
    env.TRUSS_MAIN_TOKEN = mainToken;

    // stdin is a pipe we never write to: when Electron dies (even SIGKILL) the
    // write end closes and trussd sees EOF and exits (--exit-on-stdin-eof).
    const child = spawn(binary, ['--exit-on-stdin-eof'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    startupProcess = child;
    // Swallow EPIPE etc. on the parent-death pipe; the child handle keeps it referenced.
    child.stdin?.on('error', () => {});

    let stdout = '';
    let port: number | null = null;
    let token: string | null = null;
    let healthStarted = false;
    let exitReason: string | null = null;
    const exitListeners: Array<(reason: string) => void> = [];

    const clearTimer = () => {
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
    };

    const stopStartupProcess = () => {
      const proc = startupProcess;
      if (!proc) return;
      startupProcess = null;
      if (proc.exitCode !== null || proc.killed) return;
      try {
        proc.kill('SIGTERM');
      } catch {
        // Ignore kill failures on startup cleanup.
      }
    };

    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      stopStartupProcess();
      reject(err);
    };

    const maybeResolve = () => {
      if (settled || healthStarted || port === null || !token) return;
      healthStarted = true;
      const resolvedPort = port;
      const resolvedToken = token;
      waitForHealth(resolvedPort, resolvedToken)
        .then(() => {
          if (settled) return;
          settled = true;
          clearTimer();
          startupProcess = null;
          const config: DaemonConfig = { port: resolvedPort, token: resolvedToken };
          mainTokens.set(config, mainToken);
          resolve({
            config,
            onExit(cb) {
              if (exitReason !== null) {
                cb(exitReason);
                return;
              }
              exitListeners.push(cb);
            },
            kill() {
              killWithEscalation(child);
            },
          });
        })
        .catch((err) => rejectOnce(err instanceof Error ? err : new Error(String(err))));
    };

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();

      const portMatch = stdout.match(/TRUSS_PORT=(\d+)/);
      if (portMatch) {
        port = parseInt(portMatch[1], 10);
      }
      const tokenMatch = stdout.match(/TRUSS_TOKEN=([a-fA-F0-9]{64})/);
      if (tokenMatch) {
        token = tokenMatch[1].toLowerCase();
      }

      maybeResolve();
    });

    child.stderr?.on('data', (data: Buffer) => {
      console.error(`[trussd] ${data.toString()}`);
    });

    const notifyExit = (reason: string) => {
      if (exitReason !== null) return;
      exitReason = reason;
      for (const cb of exitListeners.splice(0)) cb(reason);
    };

    child.on('error', (err) => {
      startupProcess = null;
      rejectOnce(new Error(`Failed to start daemon: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      startupProcess = null;
      notifyExit(signal ? `signal ${signal}` : `code ${code}`);
      if (settled) return;
      if (code === 0) {
        rejectOnce(new Error('Daemon exited before startup completed'));
        return;
      }
      rejectOnce(new Error(`Daemon exited with code ${code}`));
    });

    // Timeout after 10 seconds.
    startupTimer = setTimeout(() => {
      rejectOnce(new Error('Daemon startup timed out'));
    }, 10000);
  });
}

async function waitForHealth(port: number, token: string, retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pingDaemon(port, token, 2000);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('Daemon health check failed');
}

export function pingDaemon(port: number, token: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const postData = '{}';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/truss.v1.HealthService/Ping',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Connect-Protocol-Version': '1',
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`Health check returned ${res.statusCode}`));
        }
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Health check timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Start supervising trussd. Resolves after the first launch attempt settles;
 * on failure the supervisor keeps retrying in the background with backoff.
 * `getOptions` is re-read on every (re)start so updated PATH hints apply.
 */
export async function startDaemonSupervisor(
  getOptions: () => StartDaemonOptions,
  onState: (state: DaemonStatePayload, config: DaemonConfig | null) => void,
): Promise<void> {
  if (supervisor) return;
  supervisor = new DaemonSupervisor<DaemonConfig>({
    launch: () => launchDaemon(getOptions()),
    ping: (cfg, timeoutMs) => pingDaemon(cfg.port, cfg.token, timeoutMs),
    onState: (state, config) => {
      if (state.status === 'ready' && config) {
        console.log(`Daemon ready on port ${config.port} (epoch ${state.epoch})`);
      } else if (state.error) {
        console.error(`Daemon ${state.status}: ${state.error}`);
      }
      onState(state, config);
    },
  });
  await supervisor.start();
}

export function getDaemonState(): DaemonStatePayload {
  return supervisor ? supervisor.getState() : { status: 'starting', epoch: 0 };
}

export function getDaemonConfig(): DaemonConfig | null {
  return supervisor ? supervisor.getConfig() : null;
}

/**
 * Daemon access for the main process only (adds the main-only token). Never
 * expose the result through IPC/preload.
 */
export function getDaemonMainAccess(): (DaemonConfig & { mainToken: string }) | null {
  const config = getDaemonConfig();
  if (!config) return null;
  const mainToken = mainTokens.get(config);
  if (!mainToken) return null;
  return { ...config, mainToken };
}

/** Trigger an immediate health ping (or a pending restart), e.g. after resume. */
export function checkDaemonNow(): void {
  supervisor?.checkNow();
}

/** Intentional stop: the supervisor will not restart the daemon. */
export function stopDaemon(): void {
  supervisor?.stop();
}
