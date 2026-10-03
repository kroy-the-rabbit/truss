// Plugin consent and identity, owned by the Electron main process.
//
// Third-party plugins (folders under <config>/plugins) are disabled until the
// user approves them. An approval is pinned to a fingerprint of the plugin's
// manifest and entry file; if either changes the plugin is disabled again
// until it is re-approved. Approvals live in <config>/plugin-approvals.json,
// outside the plugins directory, and are only written by main in response to
// the dedicated `plugin-set-approval` IPC (which ends in a native confirmation
// dialog) or when the user keeps a plugin disabled.
//
// This module has no Electron imports so it can be unit tested with temp dirs.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolvePluginFilePath } from './pluginFs';

export const PLUGIN_ID_RE = /^[a-zA-Z0-9._-]{1,120}$/;
export const APPROVALS_FILE = 'plugin-approvals.json';

export type ApprovalDecision = 'approved' | 'denied';

export interface ApprovalRecord {
  decision: ApprovalDecision;
  // Fingerprint the decision was made against. For 'denied' it is informational.
  fingerprint: string;
  decidedAt: string;
  path: string;
}

export type ApprovalMap = Record<string, ApprovalRecord>;

// approved: approved and unchanged since approval — the only loadable state.
// pending:  never decided (new plugin, or pre-consent install being migrated).
// changed:  approved before, but manifest/entry no longer match the approval.
// denied:   user chose "Keep disabled" (or revoked).
// invalid:  manifest/entry could not be read or failed validation.
export type PluginConsentStatus = 'approved' | 'pending' | 'changed' | 'denied' | 'invalid';

export interface ConsentEvaluation {
  status: PluginConsentStatus;
  enabled: boolean;
  needsPrompt: boolean;
}

export interface DiscoveredPlugin {
  id: string;
  path: string;
  // Parsed manifest; null when manifest.json is unreadable.
  manifest: Record<string, unknown> | null;
  fingerprint: string | null;
  entryCode: string | null;
  error?: string;
}

/**
 * sha256 over the manifest and entry bytes, length-prefixed so the boundary
 * between the two files cannot be shifted to produce a collision.
 */
export function computePluginFingerprint(manifest: Buffer | string, entry: Buffer | string): string {
  const m = Buffer.isBuffer(manifest) ? manifest : Buffer.from(manifest, 'utf8');
  const e = Buffer.isBuffer(entry) ? entry : Buffer.from(entry, 'utf8');
  return crypto
    .createHash('sha256')
    .update('truss-plugin-fingerprint-v1\0')
    .update(`${m.length}\0`)
    .update(m)
    .update(`\0${e.length}\0`)
    .update(e)
    .digest('hex');
}

export function evaluateConsent(record: ApprovalRecord | undefined, fingerprint: string | null): ConsentEvaluation {
  if (!fingerprint) return { status: 'invalid', enabled: false, needsPrompt: false };
  if (!record) return { status: 'pending', enabled: false, needsPrompt: true };
  if (record.decision === 'denied') return { status: 'denied', enabled: false, needsPrompt: false };
  if (record.fingerprint === fingerprint) return { status: 'approved', enabled: true, needsPrompt: false };
  return { status: 'changed', enabled: false, needsPrompt: true };
}

/** Read one plugin folder: manifest, entry code and fingerprint. Never throws. */
export function readPluginFromDisk(pluginsDir: string, dirName: string): DiscoveredPlugin {
  const pluginDir = path.join(pluginsDir, dirName);
  const base: DiscoveredPlugin = { id: dirName, path: pluginDir, manifest: null, fingerprint: null, entryCode: null };
  let manifestBytes: Buffer;
  let manifest: Record<string, unknown>;
  try {
    manifestBytes = fs.readFileSync(path.join(pluginDir, 'manifest.json'));
    manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest is not an object');
  } catch (err) {
    return { ...base, error: `Invalid manifest.json: ${err instanceof Error ? err.message : String(err)}` };
  }
  const withManifest = { ...base, manifest };
  if (manifest.id !== dirName || !PLUGIN_ID_RE.test(dirName)) {
    return { ...withManifest, error: `Manifest id "${String(manifest.id)}" must match the plugin folder name "${dirName}"` };
  }
  if (typeof manifest.entry !== 'string' || manifest.entry === '') {
    return { ...withManifest, error: 'Manifest has no entry file' };
  }
  try {
    const entryPath = resolvePluginFilePath(path.resolve(pluginDir), manifest.entry);
    const entryBytes = fs.readFileSync(entryPath);
    return {
      ...withManifest,
      fingerprint: computePluginFingerprint(manifestBytes, entryBytes),
      entryCode: entryBytes.toString('utf8'),
    };
  } catch (err) {
    return { ...withManifest, error: `Cannot read entry: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Discover every plugin folder. Missing directory → empty list. */
export function discoverPluginsOnDisk(pluginsDir: string): DiscoveredPlugin[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => readPluginFromDisk(pluginsDir, name))
    // Folders without any manifest are not plugins (matches previous behaviour).
    .filter((p) => p.manifest !== null);
}

export function readApprovals(file: string): ApprovalMap {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ApprovalMap = {};
    for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
      const r = rec as Partial<ApprovalRecord> | null;
      if (!PLUGIN_ID_RE.test(id) || !r || (r.decision !== 'approved' && r.decision !== 'denied')) continue;
      if (typeof r.fingerprint !== 'string') continue;
      out[id] = {
        decision: r.decision,
        fingerprint: r.fingerprint,
        decidedAt: typeof r.decidedAt === 'string' ? r.decidedAt : '',
        path: typeof r.path === 'string' ? r.path : '',
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeApprovals(file: string, map: ApprovalMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Pre-consent installs kept their enable state in plugins/enabled.json and were
 * enabled unless set to false. A plugin the user had explicitly disabled is
 * recorded as denied (no need to ask); everything else without an approval
 * record stays pending and is asked about once.
 */
export function migrateLegacyEnabledMap(
  approvals: ApprovalMap,
  legacyEnabled: Record<string, unknown>,
  discovered: DiscoveredPlugin[],
  now: Date = new Date(),
): { approvals: ApprovalMap; changed: boolean } {
  let changed = false;
  const next: ApprovalMap = { ...approvals };
  for (const p of discovered) {
    if (next[p.id] || !p.fingerprint) continue;
    if (legacyEnabled[p.id] === false) {
      next[p.id] = { decision: 'denied', fingerprint: p.fingerprint, decidedAt: now.toISOString(), path: p.path };
      changed = true;
    }
  }
  return { approvals: next, changed };
}

export function recordDecision(
  approvals: ApprovalMap,
  plugin: DiscoveredPlugin,
  decision: ApprovalDecision,
  now: Date = new Date(),
): ApprovalMap {
  if (decision === 'approved' && !plugin.fingerprint) {
    throw new Error(`Plugin "${plugin.id}" cannot be approved: ${plugin.error ?? 'unreadable'}`);
  }
  return {
    ...approvals,
    [plugin.id]: { decision, fingerprint: plugin.fingerprint ?? '', decidedAt: now.toISOString(), path: plugin.path },
  };
}

export interface PluginListRecord {
  manifest: Record<string, unknown>;
  enabled: boolean;
  path: string;
  isBuiltin: false;
  consent: PluginConsentStatus;
  needsConsent: boolean;
  fingerprint: string | null;
  loadError?: string;
}

export function buildPluginRecords(discovered: DiscoveredPlugin[], approvals: ApprovalMap): PluginListRecord[] {
  return discovered.map((p) => {
    const ev = evaluateConsent(approvals[p.id], p.fingerprint);
    const rec: PluginListRecord = {
      manifest: { ...(p.manifest ?? {}), id: p.id },
      enabled: ev.enabled,
      path: p.path,
      isBuiltin: false,
      consent: ev.status,
      needsConsent: ev.needsPrompt,
      fingerprint: p.fingerprint,
    };
    if (p.error) rec.loadError = p.error;
    return rec;
  });
}

/**
 * Per-plugin storage capabilities. The renderer never names a plugin when it
 * touches storage; it presents an opaque token that main minted for exactly
 * one (renderer, plugin) pair. A token for a given plugin is minted at most
 * once per renderer document, and the host claims all of them before it runs
 * any plugin code, so a plugin cannot obtain another plugin's token later.
 */
export class PluginCapabilityRegistry {
  private tokens = new Map<string, { ownerId: number; pluginId: string }>();
  private issued = new Map<number, Set<string>>();

  constructor(private randomToken: () => string = () => crypto.randomBytes(32).toString('hex')) {}

  /** Mint a token, or null if one was already minted for this owner+plugin. */
  issue(ownerId: number, pluginId: string): string | null {
    let set = this.issued.get(ownerId);
    if (!set) {
      set = new Set();
      this.issued.set(ownerId, set);
    }
    if (set.has(pluginId)) return null;
    set.add(pluginId);
    const token = this.randomToken();
    this.tokens.set(token, { ownerId, pluginId });
    return token;
  }

  resolve(ownerId: number, token: unknown): string | null {
    if (typeof token !== 'string') return null;
    const hit = this.tokens.get(token);
    if (!hit || hit.ownerId !== ownerId) return null;
    return hit.pluginId;
  }

  /** Invalidate every token for a plugin (revocation or code change). */
  revokePlugin(pluginId: string): void {
    for (const [token, v] of this.tokens) {
      if (v.pluginId === pluginId) this.tokens.delete(token);
    }
    // Allow a fresh token after re-approval.
    for (const set of this.issued.values()) set.delete(pluginId);
  }

  /** Forget an owner entirely (renderer navigated, crashed or was destroyed). */
  resetOwner(ownerId: number): void {
    for (const [token, v] of this.tokens) {
      if (v.ownerId === ownerId) this.tokens.delete(token);
    }
    this.issued.delete(ownerId);
  }
}
