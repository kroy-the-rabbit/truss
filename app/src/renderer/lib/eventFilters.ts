export type EventSuppressionRule = {
  kind: string;   // '*' or exact kind (case-insensitive)
  reason: string; // '*' or exact reason (case-insensitive)
};

export type NormalizedUiEvent = {
  type: string;
  kind: string;
  name: string;
  namespace: string;
  reason: string;
  message: string;
  source: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
};

type OverviewLike = {
  namespace?: string;
  involvedKind?: string;
  involvedName?: string;
  reason?: string;
  message?: string;
  lastTime?: string;
  count?: number;
};

type EventItemLike = {
  type?: string;
  reason?: string;
  message?: string;
  source?: string;
  firstSeen?: string;
  lastSeen?: string;
  count?: number;
  involvedObject?: string;
};

export const DEFAULT_EVENT_SUPPRESSION_RULE_LINES = [
  'Node:Ready',
  'Node:NodeReady',
  'Node:NodeNotReady',
  '*:deprecatedAnnotation',
];

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function splitInvolvedObject(v: string): { kind: string; name: string } {
  const text = (v || '').trim();
  if (!text) return { kind: '', name: '' };
  const slash = text.indexOf('/');
  if (slash < 0) return { kind: text, name: '' };
  return { kind: text.slice(0, slash).trim(), name: text.slice(slash + 1).trim() };
}

export function normalizeOverviewEvent(ev: OverviewLike): NormalizedUiEvent {
  return {
    type: 'Warning',
    kind: ev.involvedKind || '',
    name: ev.involvedName || '',
    namespace: ev.namespace || '',
    reason: ev.reason || '',
    message: ev.message || '',
    source: '',
    firstSeen: '',
    lastSeen: ev.lastTime || '',
    count: Number(ev.count || 0),
  };
}

export function normalizeResourceEvent(ev: EventItemLike): NormalizedUiEvent {
  const obj = splitInvolvedObject(ev.involvedObject || '');
  return {
    type: ev.type || '',
    kind: obj.kind,
    name: obj.name,
    namespace: '',
    reason: ev.reason || '',
    message: ev.message || '',
    source: ev.source || '',
    firstSeen: ev.firstSeen || '',
    lastSeen: ev.lastSeen || '',
    count: Number(ev.count || 0),
  };
}

export function parseEventSuppressionRules(value: string | string[] | null | undefined): EventSuppressionRule[] {
  const lines = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  const out: EventSuppressionRule[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 2) continue;
    const kind = (parts.shift() || '').trim() || '*';
    const reason = parts.join(':').trim();
    if (!reason) continue;
    const key = `${norm(kind)}:${norm(reason)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, reason });
  }
  return out;
}

export function matchesEventSuppressionRule(ev: NormalizedUiEvent, rule: EventSuppressionRule): boolean {
  const rk = norm(rule.kind);
  const rr = norm(rule.reason);
  const ek = norm(ev.kind);
  const er = norm(ev.reason);
  const kindMatch = rk === '*' || rk === ek;
  const reasonMatch = rr === '*' || rr === er;
  return kindMatch && reasonMatch;
}

export function isEventSuppressed(ev: NormalizedUiEvent, rules: EventSuppressionRule[]): boolean {
  if (!ev.reason && !ev.message) return true;
  return rules.some((r) => matchesEventSuppressionRule(ev, r));
}

export function compileSuppressionRules(ruleLines: string[] | null | undefined): EventSuppressionRule[] {
  return parseEventSuppressionRules(ruleLines && ruleLines.length > 0 ? ruleLines : DEFAULT_EVENT_SUPPRESSION_RULE_LINES);
}
