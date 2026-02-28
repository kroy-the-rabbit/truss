import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { app } from 'electron';
import http from 'http';

export interface DaemonConfig {
  port: number;
  token: string;
}

export interface StartDaemonOptions {
  pathHints?: string[];
}

let daemonProcess: ChildProcess | null = null;

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

export async function startDaemon(opts?: StartDaemonOptions): Promise<DaemonConfig> {
  const binary = findDaemonBinary();

  return new Promise((resolve, reject) => {
    let settled = false;
    let startupTimer: NodeJS.Timeout | null = null;
    let startupProcess: ChildProcess | null = null;
    const env = {
      ...process.env,
      PATH: enrichPath(opts?.pathHints || []),
    };

    const child = spawn(binary, [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    startupProcess = child;

    let stdout = '';
    let port: number | null = null;
    let token: string | null = null;

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
      if (settled || port === null || !token) return;
      const resolvedPort = port;
      const resolvedToken = token;
      waitForHealth(resolvedPort, resolvedToken)
        .then(() => {
          if (settled) return;
          settled = true;
          clearTimer();
          daemonProcess = child;
          startupProcess = null;
          resolve({ port: resolvedPort, token: resolvedToken });
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

    child.on('error', (err) => {
      if (daemonProcess === child) {
        daemonProcess = null;
      }
      startupProcess = null;
      rejectOnce(new Error(`Failed to start daemon: ${err.message}`));
    });

    child.on('exit', (code) => {
      if (daemonProcess === child) {
        daemonProcess = null;
      }
      startupProcess = null;
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
      await pingDaemon(port, token);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('Daemon health check failed');
}

function pingDaemon(port: number, token: string): Promise<void> {
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
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`Health check returned ${res.statusCode}`));
        }
      },
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

export function stopDaemon(): void {
  if (daemonProcess) {
    daemonProcess.kill('SIGTERM');
    daemonProcess = null;
  }
}
