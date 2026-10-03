// @vitest-environment node

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import {
  buildKubectlArgs,
  buildTerminalCandidates,
  fetchVaultKubeconfig,
  isDns1123Label,
  isDns1123Subdomain,
  KubeconfigFiles,
  openExternalTerminal,
  parseTerminalRequest,
  resolveKubeconfigDir,
  STALE_KUBECONFIG_MAX_AGE_MS,
  TerminalCandidate,
  TerminalRequest,
} from '../../src/main/externalTerminal';

const posix = process.platform !== 'win32';
const CONTEXT = 'prod"ctx & calc.exe; $(rm -rf ~)';

function req(over: Partial<TerminalRequest> = {}): TerminalRequest {
  return {
    type: 'logs',
    context: CONTEXT,
    namespace: 'apps',
    pod: 'web-7d9f.abc',
    container: 'nginx',
    ...over,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-term-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('DNS-1123 validation', () => {
  test('labels', () => {
    expect(isDns1123Label('kube-system')).toBe(true);
    expect(isDns1123Label('a')).toBe(true);
    for (const bad of ['', '-a', 'a-', 'A', 'a.b', 'a b', "a'b", 'a;b', 'x'.repeat(64), 5, undefined]) {
      expect(isDns1123Label(bad)).toBe(false);
    }
  });
  test('subdomains', () => {
    expect(isDns1123Subdomain('web-1.abc')).toBe(true);
    for (const bad of ['', '.a', 'a.', 'a..b', 'A.b', 'a/b', 'a"b', `a${'.b'.repeat(130)}`]) {
      expect(isDns1123Subdomain(bad)).toBe(false);
    }
  });
  test('parseTerminalRequest rejects unsafe names', () => {
    const ok = { type: 'exec', context: 'c', namespace: 'ns', pod: 'p', container: 'c' };
    expect(parseTerminalRequest(ok).type).toBe('exec');
    expect(() => parseTerminalRequest({ ...ok, namespace: 'ns; rm -rf /' })).toThrow(/namespace/);
    expect(() => parseTerminalRequest({ ...ok, pod: '$(id)' })).toThrow(/pod/);
    expect(() => parseTerminalRequest({ ...ok, container: 'a"b' })).toThrow(/container/);
    expect(() => parseTerminalRequest({ ...ok, context: '' })).toThrow(/context/);
    expect(() => parseTerminalRequest({ ...ok, type: 'shell' })).toThrow(/type/);
    expect(() => parseTerminalRequest({ ...ok, type: 'logs', tailLines: '10; id' })).toThrow(/tailLines/);
    expect(() => parseTerminalRequest(null)).toThrow();
  });
});

describe('terminal command construction', () => {
  const kc = '/run/user/1000/truss/kc-0123456789abcdef0123456789abcdef.yaml';

  test('kubectl args never carry --context', () => {
    for (const type of ['logs', 'exec'] as const) {
      const args = buildKubectlArgs(req({ type, tailLines: 50, timestamps: true }));
      expect(args).not.toContain('--context');
      expect(args.join(' ')).not.toContain(CONTEXT);
    }
    expect(buildKubectlArgs(req({ tailLines: 50, timestamps: true }))).toEqual([
      'logs', '-f', '-n', 'apps', 'web-7d9f.abc', '-c', 'nginx', '--tail', '50', '--timestamps',
    ]);
  });

  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    test(`${platform}: sets KUBECONFIG and omits the context name`, () => {
      for (const type of ['logs', 'exec'] as const) {
        const cands = buildTerminalCandidates(platform, req({ type }), kc, { PATH: '/usr/bin', KUBECONFIG: '/home/u/.kube/config' });
        expect(cands.length).toBeGreaterThan(0);
        for (const c of cands) {
          expect(c.env.KUBECONFIG).toBe(kc);
          expect(c.env.PATH).toBe('/usr/bin');
          const line = [c.cmd, ...c.args].join(' ');
          expect(line).not.toContain('--context');
          expect(line).not.toContain('prod');
          expect(line).toContain('kubectl');
        }
      }
    });
  }

  test('linux keeps terminal detection order and exports KUBECONFIG in-shell', () => {
    const cands = buildTerminalCandidates('linux', req(), kc, {});
    expect(cands.map((c) => c.cmd)).toEqual(['gnome-terminal', 'konsole', 'xterm']);
    expect(cands[0].args.at(-1)).toBe(`export KUBECONFIG='${kc}'; 'kubectl' 'logs' '-f' '-n' 'apps' 'web-7d9f.abc' '-c' 'nginx'; exec bash`);
  });

  test('posix quoting of an odd kubeconfig path', () => {
    const cands = buildTerminalCandidates('linux', req(), "/tmp/it's/kc.yaml", {});
    expect(cands[0].args.at(-1)).toContain(`export KUBECONFIG='/tmp/it'\\''s/kc.yaml';`);
  });

  test('windows command line has no unquoted metacharacters', () => {
    const [c] = buildTerminalCandidates('win32', req({ type: 'exec' }), 'C:\\Temp\\kc.yaml', {});
    expect(c.cmd).toBe('cmd.exe');
    expect(c.windowsVerbatimArguments).toBe(true);
    const line = c.args.at(-1)!;
    expect(line).toBe('start "" cmd /k kubectl exec -it -n apps web-7d9f.abc -c nginx -- /bin/sh -c "exec bash 2>/dev/null || exec sh"');
    expect(line).not.toContain('^');
    // Outside the single fixed quoted literal, only safe characters remain.
    const outside = line.replace(/"[^"]*"/g, '');
    expect(outside).toMatch(/^[A-Za-z0-9 ._/=-]+$/);
  });
});

describe('resolveKubeconfigDir', () => {
  test('linux prefers XDG_RUNTIME_DIR/truss', () => {
    expect(resolveKubeconfigDir({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' }, tempDir: '/tmp', uid: 1000 }))
      .toBe('/run/user/1000/truss');
  });
  test('linux falls back to temp/truss-<uid>', () => {
    expect(resolveKubeconfigDir({ platform: 'linux', env: {}, tempDir: '/tmp', uid: 1000 })).toBe(path.join('/tmp', 'truss-1000'));
    expect(resolveKubeconfigDir({ platform: 'linux', env: { XDG_RUNTIME_DIR: 'relative' }, tempDir: '/tmp', uid: 7 })).toBe(path.join('/tmp', 'truss-7'));
  });
  test('darwin/win32 use a random temp dir', () => {
    const a = resolveKubeconfigDir({ platform: 'darwin', env: {}, tempDir: '/tmp', uid: 1 });
    const b = resolveKubeconfigDir({ platform: 'darwin', env: {}, tempDir: '/tmp', uid: 1 });
    expect(path.basename(a)).toMatch(/^truss-kc-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('KubeconfigFiles', () => {
  function linuxFiles() {
    return new KubeconfigFiles({ platform: 'linux', env: { XDG_RUNTIME_DIR: tmp }, tempDir: tmp, uid: 0 });
  }

  test('writes private files with random names', () => {
    const files = linuxFiles();
    const a = files.write('apiVersion: v1\n');
    const b = files.write('apiVersion: v1\n');
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.join(tmp, 'truss'));
    expect(path.basename(a)).toMatch(/^kc-[0-9a-f]{32}\.yaml$/);
    expect(fs.readFileSync(a, 'utf8')).toBe('apiVersion: v1\n');
    if (posix) {
      expect(fs.statSync(a).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(a)).mode & 0o777).toBe(0o700);
    }
    expect(files.trackedFiles().sort()).toEqual([a, b].sort());
  });

  test.runIf(posix)('tightens an existing loose directory', () => {
    fs.mkdirSync(path.join(tmp, 'truss'), { mode: 0o755 });
    fs.chmodSync(path.join(tmp, 'truss'), 0o755);
    linuxFiles().write('x');
    expect(fs.statSync(path.join(tmp, 'truss')).mode & 0o777).toBe(0o700);
  });

  test.runIf(posix)('refuses a symlinked directory', () => {
    const target = path.join(tmp, 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(tmp, 'truss'));
    expect(() => linuxFiles().write('x')).toThrow(/not a directory/);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  test('cleanupAll removes every tracked file (lock / quit)', () => {
    const files = linuxFiles();
    const a = files.write('a');
    const b = files.write('b');
    files.cleanupAll();
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(files.trackedFiles()).toEqual([]);
    files.cleanupAll(); // idempotent
  });

  test('darwin cleanup also removes the random dir', () => {
    const files = new KubeconfigFiles({ platform: 'darwin', env: {}, tempDir: tmp, uid: 0 });
    const a = files.write('a');
    files.cleanupAll();
    expect(fs.existsSync(path.dirname(a))).toBe(false);
  });

  test('sweepStale removes only old kubeconfig files', () => {
    const dir = path.join(tmp, 'truss');
    fs.mkdirSync(dir, { mode: 0o700 });
    const old = path.join(dir, `kc-${'a'.repeat(32)}.yaml`);
    const fresh = path.join(dir, `kc-${'b'.repeat(32)}.yaml`);
    const unrelated = path.join(dir, 'notes.txt');
    for (const f of [old, fresh, unrelated]) fs.writeFileSync(f, 'x');
    const longAgo = (Date.now() - STALE_KUBECONFIG_MAX_AGE_MS - 60_000) / 1000;
    fs.utimesSync(old, longAgo, longAgo);
    fs.utimesSync(unrelated, longAgo, longAgo);

    linuxFiles().sweepStale();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  test('sweepStale on darwin cleans earlier random dirs', () => {
    const staleDir = path.join(tmp, `truss-kc-${'c'.repeat(32)}`);
    const keepDir = path.join(tmp, `truss-kc-${'d'.repeat(32)}`);
    const otherDir = path.join(tmp, 'truss-other');
    for (const d of [staleDir, keepDir, otherDir]) fs.mkdirSync(d);
    const staleFile = path.join(staleDir, `kc-${'e'.repeat(32)}.yaml`);
    const freshFile = path.join(keepDir, `kc-${'f'.repeat(32)}.yaml`);
    fs.writeFileSync(staleFile, 'x');
    fs.writeFileSync(freshFile, 'x');
    const longAgo = (Date.now() - STALE_KUBECONFIG_MAX_AGE_MS - 60_000) / 1000;
    fs.utimesSync(staleFile, longAgo, longAgo);

    new KubeconfigFiles({ platform: 'darwin', env: {}, tempDir: tmp, uid: 0 }).sweepStale();
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
    expect(fs.existsSync(otherDir)).toBe(true);
  });
});

describe('openExternalTerminal', () => {
  const access = { port: 1, token: 't', mainToken: 'm' };

  function deps(over: Partial<Parameters<typeof openExternalTerminal>[1]> = {}) {
    const launched: TerminalCandidate[][] = [];
    const files = new KubeconfigFiles({ platform: 'linux', env: { XDG_RUNTIME_DIR: tmp }, tempDir: tmp, uid: 0 });
    const d = {
      platform: 'linux' as NodeJS.Platform,
      env: {},
      isLocked: () => false,
      getAccess: () => access,
      files,
      fetchKubeconfig: vi.fn(async () => 'apiVersion: v1\ncurrent-context: x\n'),
      launch: (c: TerminalCandidate[]) => { launched.push(c); },
      ...over,
    };
    return { d, launched, files };
  }

  const opts = { type: 'logs', context: CONTEXT, namespace: 'apps', pod: 'web', container: 'nginx' };

  test('locked vault is rejected before any export', async () => {
    const { d, launched } = deps({ isLocked: () => true });
    await expect(openExternalTerminal(opts, d)).rejects.toThrow(/locked/);
    expect(d.fetchKubeconfig).not.toHaveBeenCalled();
    expect(launched).toEqual([]);
  });

  test('lock during export discards the file', async () => {
    let locked = false;
    const { d, launched, files } = deps({ isLocked: () => locked });
    d.fetchKubeconfig.mockImplementation(async () => { locked = true; return 'x'; });
    await expect(openExternalTerminal(opts, d)).rejects.toThrow(/locked/);
    expect(launched).toEqual([]);
    expect(files.trackedFiles()).toEqual([]);
  });

  test('writes the vault kubeconfig and launches with KUBECONFIG', async () => {
    const { d, launched, files } = deps();
    await openExternalTerminal(opts, d);
    expect(d.fetchKubeconfig).toHaveBeenCalledWith(access, CONTEXT);
    const [file] = files.trackedFiles();
    expect(fs.readFileSync(file, 'utf8')).toContain('current-context: x');
    expect(launched).toHaveLength(1);
    expect(launched[0][0].env.KUBECONFIG).toBe(file);
    expect(launched[0][0].args.join(' ')).not.toContain('prod');
  });

  test('daemon not ready / invalid input are rejected', async () => {
    await expect(openExternalTerminal(opts, deps({ getAccess: () => null }).d)).rejects.toThrow(/not ready/);
    await expect(openExternalTerminal({ ...opts, pod: 'a b' }, deps().d)).rejects.toThrow(/pod/);
  });
});

describe('fetchVaultKubeconfig', () => {
  let server: http.Server;
  let port: number;
  let seen: http.IncomingHttpHeaders | null;
  let seenBody: string;
  let status = 200;
  let reply: unknown = { kubeconfig: 'apiVersion: v1\n' };

  beforeEach(async () => {
    seen = null;
    status = 200;
    reply = { kubeconfig: 'apiVersion: v1\n' };
    server = http.createServer((rq, rs) => {
      let b = '';
      rq.on('data', (c) => { b += c; });
      rq.on('end', () => {
        seen = rq.headers;
        seenBody = b;
        rs.writeHead(status, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  test('sends both tokens and returns the yaml', async () => {
    const yaml = await fetchVaultKubeconfig({ port, token: 'bearer', mainToken: 'main' }, 'ctx');
    expect(yaml).toBe('apiVersion: v1\n');
    expect(seen?.authorization).toBe('Bearer bearer');
    expect(seen?.['x-truss-main-token']).toBe('main');
    expect(JSON.parse(seenBody)).toEqual({ context: 'ctx' });
  });

  test('surfaces daemon errors', async () => {
    status = 409;
    reply = { error: 'exec plugin not approved' };
    await expect(fetchVaultKubeconfig({ port, token: 'b', mainToken: 'm' }, 'ctx')).rejects.toThrow(/exec plugin not approved/);
  });
});
