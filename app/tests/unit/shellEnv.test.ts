// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { isAllowedShellEnvKey, mergeShellEnv, parseNullDelimitedEnv } from '../../src/main/shellEnv';

describe('parseNullDelimitedEnv', () => {
  test('parses entries and tolerates shell banner noise and multiline values', () => {
    const out = 'Welcome to zsh!\nlast login\nPATH=/a:/b\0AWS_PROFILE=prod\0MULTI=line1\nline2\0=bad\0\0';
    expect(parseNullDelimitedEnv(out)).toEqual({ PATH: '/a:/b', AWS_PROFILE: 'prod', MULTI: 'line1\nline2' });
  });
});

describe('isAllowedShellEnvKey', () => {
  test('allowlist', () => {
    for (const k of ['AWS_PROFILE', 'CLOUDSDK_CONFIG', 'AZURE_CONFIG_DIR', 'GOOGLE_APPLICATION_CREDENTIALS', 'KUBECACHEDIR', 'HTTPS_PROXY', 'https_proxy', 'No_Proxy', 'http_proxy']) {
      expect(isAllowedShellEnvKey(k)).toBe(true);
    }
    for (const k of ['PATH', 'HOME', 'SECRET_TOKEN', 'AWS', 'KUBECONFIG', 'LD_PRELOAD', 'ALL_PROXY']) {
      expect(isAllowedShellEnvKey(k)).toBe(false);
    }
  });
});

describe('mergeShellEnv', () => {
  test('shell PATH first, then enriched PATH, deduped', () => {
    const merged = mergeShellEnv(
      { PATH: '/usr/bin', HOME: '/home/u' },
      { PATH: '/opt/gcloud/bin:/usr/bin:/home/u/.local/bin' },
      '/usr/bin:/usr/local/bin:/home/u/.local/bin',
    );
    expect(merged.PATH).toBe('/opt/gcloud/bin:/usr/bin:/home/u/.local/bin:/usr/local/bin');
    expect(merged.HOME).toBe('/home/u');
  });

  test('passes only allowlisted vars and never overrides explicit base values', () => {
    const merged = mergeShellEnv(
      { PATH: '/usr/bin', AWS_PROFILE: 'from-launcher' },
      {
        PATH: '/x',
        AWS_PROFILE: 'from-shell',
        AWS_REGION: 'us-east-1',
        CLOUDSDK_CORE_PROJECT: 'proj',
        https_proxy: 'http://proxy:3128',
        SECRET_TOKEN: 'nope',
        LD_PRELOAD: '/evil.so',
      },
      '/usr/bin',
    );
    expect(merged.AWS_PROFILE).toBe('from-launcher');
    expect(merged.AWS_REGION).toBe('us-east-1');
    expect(merged.CLOUDSDK_CORE_PROJECT).toBe('proj');
    expect(merged.https_proxy).toBe('http://proxy:3128');
    expect(merged.SECRET_TOKEN).toBeUndefined();
    expect(merged.LD_PRELOAD).toBeUndefined();
    expect(merged.PATH).toBe('/x:/usr/bin');
  });

  test('null shell env keeps the enriched PATH', () => {
    const merged = mergeShellEnv({ PATH: '/usr/bin', FOO: 'bar' }, null, '/usr/bin:/usr/local/bin');
    expect(merged).toEqual({ PATH: '/usr/bin:/usr/local/bin', FOO: 'bar' });
  });

  test('windows delimiter', () => {
    const merged = mergeShellEnv({}, { PATH: 'C:\\a;C:\\b' }, 'C:\\b;C:\\c', ';');
    expect(merged.PATH).toBe('C:\\a;C:\\b;C:\\c');
  });
});
