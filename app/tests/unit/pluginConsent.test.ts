// @vitest-environment node
// Plugin consent state machine and storage identity binding (main process).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildPluginRecords,
  computePluginFingerprint,
  discoverPluginsOnDisk,
  evaluateConsent,
  migrateLegacyEnabledMap,
  PluginCapabilityRegistry,
  readApprovals,
  readPluginFromDisk,
  recordDecision,
  writeApprovals,
  type ApprovalMap,
} from '../../src/main/pluginConsent';

let tmp: string;
let pluginsDir: string;
let approvalsFile: string;

function writePlugin(id: string, code = 'export function register() {}', manifestOverrides: Record<string, unknown> = {}) {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id, name: `Plugin ${id}`, version: '1.0.0', apiVersion: '1', capabilities: ['action-button'], entry: 'index.js', ...manifestOverrides };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.js'), code);
}

function statusOf(id: string, approvals: ApprovalMap) {
  const p = readPluginFromDisk(pluginsDir, id);
  return evaluateConsent(approvals[id], p.fingerprint);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-plugin-consent-'));
  pluginsDir = path.join(tmp, 'plugins');
  approvalsFile = path.join(tmp, 'plugin-approvals.json');
  fs.mkdirSync(pluginsDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fingerprint', () => {
  test('changes when manifest or entry changes and is boundary-safe', () => {
    const base = computePluginFingerprint('{"a":1}', 'code');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(computePluginFingerprint('{"a":1}', 'code')).toBe(base);
    expect(computePluginFingerprint('{"a":2}', 'code')).not.toBe(base);
    expect(computePluginFingerprint('{"a":1}', 'code2')).not.toBe(base);
    // Moving bytes across the manifest/entry boundary must not collide.
    expect(computePluginFingerprint('ab', 'c')).not.toBe(computePluginFingerprint('a', 'bc'));
  });
});

describe('consent state machine', () => {
  test('new plugin is disabled and needs a prompt', () => {
    writePlugin('alpha');
    expect(statusOf('alpha', {})).toEqual({ status: 'pending', enabled: false, needsPrompt: true });
  });

  test('approve → enabled; code change → disabled pending re-approval', () => {
    writePlugin('alpha');
    let approvals = recordDecision({}, readPluginFromDisk(pluginsDir, 'alpha'), 'approved');
    expect(statusOf('alpha', approvals)).toEqual({ status: 'approved', enabled: true, needsPrompt: false });

    writePlugin('alpha', 'export function register() { /* evil */ }');
    expect(statusOf('alpha', approvals)).toEqual({ status: 'changed', enabled: false, needsPrompt: true });

    approvals = recordDecision(approvals, readPluginFromDisk(pluginsDir, 'alpha'), 'approved');
    expect(statusOf('alpha', approvals).status).toBe('approved');
  });

  test('manifest change also invalidates approval', () => {
    writePlugin('alpha');
    const approvals = recordDecision({}, readPluginFromDisk(pluginsDir, 'alpha'), 'approved');
    writePlugin('alpha', 'export function register() {}', { capabilities: ['theme', 'inspector-tab'] });
    expect(statusOf('alpha', approvals).status).toBe('changed');
  });

  test('keep disabled persists and is not asked again', () => {
    writePlugin('alpha');
    const approvals = recordDecision({}, readPluginFromDisk(pluginsDir, 'alpha'), 'denied');
    writeApprovals(approvalsFile, approvals);
    expect(statusOf('alpha', readApprovals(approvalsFile))).toEqual({ status: 'denied', enabled: false, needsPrompt: false });
  });

  test('unreadable entry or mismatched id is invalid and cannot be approved', () => {
    writePlugin('alpha', 'x', { entry: 'missing.js' });
    writePlugin('beta', 'x', { id: 'gamma' });
    const alpha = readPluginFromDisk(pluginsDir, 'alpha');
    const beta = readPluginFromDisk(pluginsDir, 'beta');
    expect(evaluateConsent(undefined, alpha.fingerprint).status).toBe('invalid');
    expect(beta.error).toMatch(/must match the plugin folder name/);
    expect(() => recordDecision({}, alpha, 'approved')).toThrow(/cannot be approved/);
  });

  test('entry path traversal is rejected', () => {
    fs.writeFileSync(path.join(tmp, 'outside.js'), 'evil');
    writePlugin('alpha', 'x', { entry: '../../outside.js' });
    expect(readPluginFromDisk(pluginsDir, 'alpha').fingerprint).toBeNull();
  });
});

describe('migration from pre-consent installs', () => {
  test('implicitly enabled plugins are asked once; explicit disables are kept', () => {
    writePlugin('was-enabled');
    writePlugin('was-default');
    writePlugin('was-disabled');
    const legacy = { 'was-enabled': true, 'was-disabled': false };
    const discovered = discoverPluginsOnDisk(pluginsDir);

    const { approvals, changed } = migrateLegacyEnabledMap({}, legacy, discovered);
    expect(changed).toBe(true);
    const records = buildPluginRecords(discovered, approvals);
    const byId = Object.fromEntries(records.map((r) => [r.manifest.id, r]));
    // Previously enabled (explicitly or by default) → disabled until approved.
    expect(byId['was-enabled']).toMatchObject({ enabled: false, consent: 'pending', needsConsent: true });
    expect(byId['was-default']).toMatchObject({ enabled: false, consent: 'pending', needsConsent: true });
    expect(byId['was-disabled']).toMatchObject({ enabled: false, consent: 'denied', needsConsent: false });

    // The user answers the one-time prompt; subsequent startups do not ask.
    let next = recordDecision(approvals, discovered.find((p) => p.id === 'was-enabled')!, 'approved');
    next = recordDecision(next, discovered.find((p) => p.id === 'was-default')!, 'denied');
    writeApprovals(approvalsFile, next);
    const again = migrateLegacyEnabledMap(readApprovals(approvalsFile), legacy, discoverPluginsOnDisk(pluginsDir));
    expect(again.changed).toBe(false);
    const after = buildPluginRecords(discoverPluginsOnDisk(pluginsDir), again.approvals);
    expect(after.filter((r) => r.needsConsent)).toEqual([]);
    expect(after.find((r) => r.manifest.id === 'was-enabled')!.enabled).toBe(true);
  });

  test('approvals file ignores malformed entries', () => {
    fs.writeFileSync(approvalsFile, JSON.stringify({
      good: { decision: 'approved', fingerprint: 'abc', decidedAt: 'x', path: '/p' },
      'bad id!': { decision: 'approved', fingerprint: 'abc' },
      weird: { decision: 'maybe', fingerprint: 'abc' },
    }));
    expect(Object.keys(readApprovals(approvalsFile))).toEqual(['good']);
    fs.writeFileSync(approvalsFile, 'not json');
    expect(readApprovals(approvalsFile)).toEqual({});
  });
});

describe('storage capabilities bind plugin identity', () => {
  test('plugin A cannot use or obtain B\'s capability', () => {
    const caps = new PluginCapabilityRegistry();
    const owner = 7;
    const a = caps.issue(owner, 'a')!;
    const b = caps.issue(owner, 'b')!;
    expect(caps.resolve(owner, a)).toBe('a');
    expect(caps.resolve(owner, b)).toBe('b');
    // A naming B's id is meaningless: ids are not capabilities.
    expect(caps.resolve(owner, 'b')).toBeNull();
    // Once the host has claimed B's capability, nobody can mint another.
    expect(caps.issue(owner, 'b')).toBeNull();
    // Capabilities do not work from another renderer.
    expect(caps.resolve(8, a)).toBeNull();
  });

  test('revocation and renderer reset invalidate capabilities', () => {
    const caps = new PluginCapabilityRegistry();
    const a = caps.issue(1, 'a')!;
    caps.revokePlugin('a');
    expect(caps.resolve(1, a)).toBeNull();
    const a2 = caps.issue(1, 'a')!;
    expect(caps.resolve(1, a2)).toBe('a');
    caps.resetOwner(1);
    expect(caps.resolve(1, a2)).toBeNull();
    expect(caps.issue(1, 'a')).not.toBeNull();
  });

  test('non-string capabilities are rejected', () => {
    const caps = new PluginCapabilityRegistry();
    caps.issue(1, 'a');
    expect(caps.resolve(1, undefined)).toBeNull();
    expect(caps.resolve(1, { toString: () => 'a' })).toBeNull();
  });
});
