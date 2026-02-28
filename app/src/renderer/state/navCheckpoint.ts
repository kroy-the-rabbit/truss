import { GVR } from '../api/gen/truss/v1/resources_pb';

// Navigation state persisted across lock/unlock cycles and app restarts.
// Two storage tiers:
//   sessionStorage  — lock/unlock path (window-scoped, cleared on close)
//   localStorage    — restart path (persists across restarts, consumed on read)
// Only navigation pointers are saved — no resource content or credentials.

const LOCK_KEY = 'truss:nav-checkpoint';   // sessionStorage
const RESTART_KEY = 'truss:nav-restart';   // localStorage
const SCHEMA_VERSION = 1;
const MAX_STR = 512;
const RESTART_MAX_AGE_MS = 24 * 60 * 60 * 1000; // discard checkpoints older than 24 h

interface NavCheckpoint {
  v: number;
  activeContext: string;
  activeNamespace: string;
  gvr: { group: string; version: string; resource: string } | null;
  selectedKindLabel: string;
  selectedResource: string;
  selectedResourceNamespace: string;
  activePane: string;
  savedAt?: number; // unix ms — present in restart checkpoints
}

function san(v: unknown, max = MAX_STR): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function parseGVR(raw: unknown): GVR | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  if (
    typeof g['group'] === 'string' &&
    typeof g['version'] === 'string' &&
    typeof g['resource'] === 'string'
  ) {
    return new GVR({
      group: g['group'].slice(0, MAX_STR),
      version: g['version'].slice(0, MAX_STR),
      resource: g['resource'].slice(0, MAX_STR),
    });
  }
  return null;
}

const VALID_PANES = ['navigator', 'list', 'inspector'] as const;
type ValidPane = (typeof VALID_PANES)[number];

function parsePane(v: unknown): ValidPane {
  const s = san(v);
  return (VALID_PANES as readonly string[]).includes(s) ? (s as ValidPane) : 'navigator';
}

function parseCheckpoint(
  raw: string | null,
  maxAgeMs?: number,
): NavSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj['v'] !== SCHEMA_VERSION) return null;

  // Staleness guard for restart checkpoints
  if (maxAgeMs !== undefined) {
    const savedAt = typeof obj['savedAt'] === 'number' ? obj['savedAt'] : 0;
    if (Date.now() - savedAt > maxAgeMs) return null;
  }

  const activeContext = san(obj['activeContext']);
  if (!activeContext) return null;

  return {
    activeContext,
    activeNamespace: san(obj['activeNamespace']),
    selectedKind: parseGVR(obj['gvr']),
    selectedKindLabel: san(obj['selectedKindLabel']),
    selectedResource: san(obj['selectedResource']),
    selectedResourceNamespace: san(obj['selectedResourceNamespace']),
    activePane: parsePane(obj['activePane']),
  };
}

export interface NavSnapshot {
  activeContext: string;
  activeNamespace: string;
  selectedKind: GVR | null;
  selectedKindLabel: string;
  selectedResource: string;
  selectedResourceNamespace: string;
  activePane: ValidPane;
}

function buildPayload(state: NavSnapshot, extra?: Partial<NavCheckpoint>): NavCheckpoint {
  return {
    v: SCHEMA_VERSION,
    activeContext: state.activeContext,
    activeNamespace: state.activeNamespace,
    gvr: state.selectedKind
      ? {
          group: state.selectedKind.group,
          version: state.selectedKind.version,
          resource: state.selectedKind.resource,
        }
      : null,
    selectedKindLabel: state.selectedKindLabel,
    selectedResource: state.selectedResource,
    selectedResourceNamespace: state.selectedResourceNamespace,
    activePane: state.activePane,
    ...extra,
  };
}

// ── Lock/unlock path (sessionStorage) ────────────────────────────────────────

export function saveNavCheckpoint(state: NavSnapshot): void {
  if (!state.activeContext) return;
  try {
    sessionStorage.setItem(LOCK_KEY, JSON.stringify(buildPayload(state)));
  } catch { /* unavailable or full */ }
}

export function restoreNavCheckpoint(): NavSnapshot | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(LOCK_KEY);
    sessionStorage.removeItem(LOCK_KEY); // consume regardless of validity
  } catch { return null; }
  return parseCheckpoint(raw);
}

// ── Restart path (localStorage) ───────────────────────────────────────────────

export function saveNavForRestart(state: NavSnapshot): void {
  if (!state.activeContext) {
    try { localStorage.removeItem(RESTART_KEY); } catch {}
    return;
  }
  try {
    localStorage.setItem(
      RESTART_KEY,
      JSON.stringify(buildPayload(state, { savedAt: Date.now() })),
    );
  } catch { /* unavailable or full */ }
}

export function restoreNavForRestart(): NavSnapshot | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(RESTART_KEY);
    localStorage.removeItem(RESTART_KEY); // consume regardless of validity
  } catch { return null; }
  return parseCheckpoint(raw, RESTART_MAX_AGE_MS);
}
