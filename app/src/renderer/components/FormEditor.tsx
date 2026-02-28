import React, { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../state/store';
import { useResourceYaml, useApplyYaml } from '../state/queries';
import type { GVR } from '../api/gen/truss/v1/resources_pb';

interface Props {
  name: string;
  namespace: string;
  gvr: GVR;
  kind: string;
}

interface KVEntry {
  key: string;
  value: string;
  id: number;
}

let nextId = 0;

function b64Decode(s: string): string {
  try {
    return atob(s);
  } catch {
    return s;
  }
}

function b64Encode(s: string): string {
  return btoa(s);
}

function parseYamlSimple(yamlStr: string): Record<string, unknown> {
  // Simple YAML to object parser for our use case.
  // We use the structured fields, not full YAML parsing.
  const lines = yamlStr.split('\n');
  const result: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: result }];

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.search(/\S/);
    const content = line.trim();

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) continue;

    const key = content.substring(0, colonIdx).trim();
    const rawValue = content.substring(colonIdx + 1).trim();

    if (rawValue === '' || rawValue === '|' || rawValue === '>') {
      // Nested object or block scalar — create sub-object
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      // Strip quotes
      let val = rawValue;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      parent[key] = val;
    }
  }
  return result;
}

function extractDataMap(yamlStr: string, section: string): Record<string, string> {
  // Extract a flat key-value section like `data:` or `stringData:` from YAML.
  const lines = yamlStr.split('\n');
  const result: Record<string, string> = {};
  let inSection = false;
  let sectionIndent = -1;
  let currentKey = '';
  let currentValue = '';
  let isBlockScalar = false;
  let blockIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Check if we're entering the target section
    if (trimmed === section + ':' || trimmed.startsWith(section + ': ')) {
      inSection = true;
      sectionIndent = indent;
      continue;
    }

    if (!inSection) continue;

    // Check if we've left the section
    if (trimmed !== '' && indent <= sectionIndent) {
      // Flush current key
      if (currentKey && isBlockScalar) {
        result[currentKey] = currentValue;
      }
      break;
    }

    if (isBlockScalar) {
      if (trimmed === '' || indent > blockIndent) {
        currentValue += (currentValue ? '\n' : '') + line.substring(blockIndent >= 0 ? blockIndent : indent);
        continue;
      } else {
        // End of block scalar
        result[currentKey] = currentValue;
        isBlockScalar = false;
        currentKey = '';
        currentValue = '';
      }
    }

    if (trimmed === '') continue;

    // Parse key: value within the section
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0 && indent > sectionIndent) {
      const key = trimmed.substring(0, colonIdx).trim();
      const rawVal = trimmed.substring(colonIdx + 1).trim();

      if (rawVal === '|' || rawVal === '|-' || rawVal === '>') {
        // Block scalar
        currentKey = key;
        currentValue = '';
        isBlockScalar = true;
        blockIndent = -1;
        // Peek ahead to find block indent
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j];
          if (nextLine.trim() !== '') {
            blockIndent = nextLine.length - nextLine.trimStart().length;
            break;
          }
        }
      } else {
        let val = rawVal;
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[key] = val;
      }
    }
  }

  // Flush remaining block scalar
  if (currentKey && isBlockScalar) {
    result[currentKey] = currentValue;
  }

  return result;
}

function buildPatchYaml(
  originalYaml: string,
  kind: string,
  dataMap: Record<string, string>,
  isSecret: boolean,
): string {
  // Extract metadata from original YAML to build a valid patch
  const parsed = parseYamlSimple(originalYaml);
  const metadata = parsed.metadata as Record<string, unknown> | undefined;

  const lines: string[] = [];
  lines.push(`apiVersion: ${parsed.apiVersion || 'v1'}`);
  lines.push(`kind: ${kind}`);
  lines.push('metadata:');
  lines.push(`  name: ${metadata?.name || ''}`);
  if (metadata?.namespace) {
    lines.push(`  namespace: ${metadata.namespace}`);
  }

  const section = isSecret ? 'data' : 'data';
  lines.push(`${section}:`);

  for (const [k, v] of Object.entries(dataMap)) {
    const finalValue = isSecret ? b64Encode(v) : v;
    // Use block scalar for multi-line values
    if (finalValue.includes('\n')) {
      lines.push(`  ${k}: |`);
      for (const vline of finalValue.split('\n')) {
        lines.push(`    ${vline}`);
      }
    } else {
      // Quote values that could be misinterpreted
      const needsQuote = finalValue === '' ||
        finalValue === 'true' || finalValue === 'false' ||
        finalValue === 'null' || finalValue === 'yes' || finalValue === 'no' ||
        /^\d/.test(finalValue);
      lines.push(`  ${k}: ${needsQuote ? '"' + finalValue.replace(/"/g, '\\"') + '"' : finalValue}`);
    }
  }

  return lines.join('\n') + '\n';
}

export function FormEditor({ name, namespace, gvr, kind }: Props) {
  const { activeContext, readOnly } = useAppStore();
  const yaml = useResourceYaml(activeContext, namespace, gvr, name);
  const applyMutation = useApplyYaml();
  const [entries, setEntries] = useState<KVEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showDecoded, setShowDecoded] = useState(true);

  const isSecret = kind === 'Secret';
  const isConfigOrSecret = kind === 'ConfigMap' || kind === 'Secret';

  // Parse data from YAML when it loads
  useEffect(() => {
    if (!yaml.data?.yaml) return;
    const dataMap = extractDataMap(yaml.data.yaml, 'data');
    const newEntries: KVEntry[] = Object.entries(dataMap).map(([k, v]) => ({
      key: k,
      value: isSecret ? b64Decode(v) : v,
      id: nextId++,
    }));
    setEntries(newEntries);
    setDirty(false);
  }, [yaml.data?.yaml, isSecret]);

  const updateEntry = useCallback((id: number, field: 'key' | 'value', val: string) => {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: val } : e));
    setDirty(true);
  }, []);

  const removeEntry = useCallback((id: number) => {
    setEntries(prev => prev.filter(e => e.id !== id));
    setDirty(true);
  }, []);

  const addEntry = useCallback(() => {
    setEntries(prev => [...prev, { key: '', value: '', id: nextId++ }]);
    setDirty(true);
  }, []);

  const handleSave = async () => {
    if (!yaml.data?.yaml) return;
    const dataMap: Record<string, string> = {};
    for (const e of entries) {
      if (e.key.trim()) {
        dataMap[e.key.trim()] = e.value;
      }
    }
    const patchYaml = buildPatchYaml(yaml.data.yaml, kind, dataMap, isSecret);
    try {
      const result = await applyMutation.mutateAsync({
        context: activeContext,
        namespace,
        yaml: patchYaml,
      });
      setMessage({ type: 'success', text: result.message });
      setDirty(false);
    } catch (err) {
      setMessage({ type: 'error', text: `Save failed: ${err}` });
    }
  };

  if (yaml.isLoading) {
    return <div className="form-editor loading">Loading...</div>;
  }

  if (yaml.isError) {
    return (
      <div className="form-editor loading">
        <span style={{ color: 'var(--error)' }}>Failed to load resource</span>
      </div>
    );
  }

  if (!isConfigOrSecret) {
    return <GenericFormEditor yaml={yaml.data?.yaml || ''} kind={kind} />;
  }

  return (
    <div className="form-editor">
      <div className="form-toolbar">
        <span className="form-toolbar-title">
          {isSecret ? 'Secret Data' : 'ConfigMap Data'}
          {isSecret && (
            <label className="form-toggle">
              <input
                type="checkbox"
                checked={showDecoded}
                onChange={(e) => setShowDecoded(e.target.checked)}
              />
              Show decoded
            </label>
          )}
        </span>
        <div className="form-toolbar-actions">
          <button onClick={addEntry} className="form-btn" disabled={readOnly}>+ Add Key</button>
          <button
            onClick={handleSave}
            disabled={readOnly || !dirty || applyMutation.isPending}
            className="form-btn form-btn-primary"
          >
            {applyMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {message && (
        <div className={`yaml-message ${message.type}`}>
          <pre>{message.text}</pre>
          <button onClick={() => setMessage(null)}>Dismiss</button>
        </div>
      )}

      <div className="form-entries">
        {entries.length === 0 && (
          <div className="form-empty">No data entries. Click "+ Add Key" to create one.</div>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="form-entry">
            <div className="form-entry-header">
              <input
                className="form-key-input"
                type="text"
                value={entry.key}
                onChange={(e) => updateEntry(entry.id, 'key', e.target.value)}
                onFocus={(e) => e.target.select()}
                placeholder="key"
                spellCheck={false}
                readOnly={readOnly}
              />
              <button
                className="form-entry-remove"
                onClick={() => removeEntry(entry.id)}
                title="Remove entry"
                disabled={readOnly}
              >
                ×
              </button>
            </div>
            <textarea
              className="form-value-input"
              value={isSecret && !showDecoded ? b64Encode(entry.value) : entry.value}
              onChange={(e) => {
                const val = isSecret && !showDecoded ? b64Decode(e.target.value) : e.target.value;
                updateEntry(entry.id, 'value', val);
              }}
              onFocus={(e) => e.target.select()}
              placeholder="value"
              rows={Math.max(2, (entry.value.split('\n').length))}
              spellCheck={false}
              readOnly={readOnly || (isSecret && !showDecoded)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function GenericFormEditor({ yaml: yamlStr, kind }: { yaml: string; kind: string }) {
  // For non-ConfigMap/Secret resources, show key metadata in a readable form
  const parsed = parseYamlSimple(yamlStr);
  const metadata = parsed.metadata as Record<string, unknown> | undefined;
  const spec = parsed.spec as Record<string, unknown> | undefined;

  return (
    <div className="form-editor">
      <div className="form-toolbar">
        <span className="form-toolbar-title">{kind} Details</span>
      </div>
      <div className="form-entries">
        <div className="form-section">
          <h3>Metadata</h3>
          <div className="form-fields">
            <div className="form-field-row">
              <span className="form-field-label">Name</span>
              <input className="form-field-value-input" readOnly value={String(metadata?.name || '')} onFocus={(e) => e.target.select()} />
            </div>
            {metadata?.namespace ? (
              <div className="form-field-row">
                <span className="form-field-label">Namespace</span>
                <input className="form-field-value-input" readOnly value={String(metadata.namespace)} onFocus={(e) => e.target.select()} />
              </div>
            ) : null}
          </div>
        </div>
        {spec && (
          <div className="form-section">
            <h3>Spec</h3>
            <div className="form-fields">
              {Object.entries(spec).map(([k, v]) => {
                if (typeof v === 'object') return null;
                return (
                  <div key={k} className="form-field-row">
                    <span className="form-field-label">{k}</span>
                    <input className="form-field-value-input" readOnly value={String(v)} onFocus={(e) => e.target.select()} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
