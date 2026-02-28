import React, { useEffect, useState } from 'react';
import { DiffEditor, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

loader.config({ monaco });

interface DiffPayload {
  context: string;
  namespace: string;
  resource: string;
  name: string;
  currentYaml: string;
  proposedYaml: string;
}

export function YamlDiffWindow() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const [payload, setPayload] = useState<DiffPayload | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!token || !api?.getYamlDiffPayload) {
      setError('Missing YAML diff payload token');
      return;
    }
    api.getYamlDiffPayload(token)
      .then((p: DiffPayload) => setPayload(p))
      .catch((err: unknown) => setError(String(err)));
  }, [token]);

  useEffect(() => {
    if (!payload) {
      document.title = 'YAML Diff';
      return;
    }
    const id = [payload.namespace, payload.name].filter(Boolean).join('/');
    document.title = id ? `${id} — YAML Diff` : 'YAML Diff';
  }, [payload]);

  const submit = async (approved: boolean) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    try {
      await api?.submitYamlDiffDecision?.(token, approved);
    } finally {
      window.close();
    }
  };

  // Keyboard shortcuts: Esc → cancel, Ctrl/Cmd+S → approve.
  useEffect(() => {
    if (!payload) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { void submit(false); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void submit(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // submit is stable within the lifetime of a loaded payload
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  if (error) {
    return (
      <div className="yaml-diff-window">
        <div className="yaml-diff-error">{error}</div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="yaml-diff-window">
        <div className="yaml-diff-loading">Loading diff...</div>
      </div>
    );
  }

  return (
    <div className="yaml-diff-window">
      <div className="yaml-diff-header">
        <div className="yaml-diff-title">
          <strong>YAML Save Confirmation</strong>
          <span>{payload.namespace}/{payload.name} ({payload.resource})</span>
          <span>Unified view: current vs proposed changes</span>
        </div>
        <div className="yaml-diff-actions">
          <button onClick={() => void submit(false)} title="Esc">Cancel</button>
          <button className="primary" onClick={() => void submit(true)} title="Ctrl+S">Save</button>
        </div>
      </div>
      <div className="yaml-diff-body">
        <DiffEditor
          height="100%"
          original={payload.currentYaml}
          modified={payload.proposedYaml}
          language="yaml"
          theme="vs-dark"
          options={{
            readOnly: true,
            renderSideBySide: false,
            minimap: { enabled: false },
            fontSize: 12,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            automaticLayout: true,
            ignoreTrimWhitespace: false,
            renderOverviewRuler: true,
          }}
        />
      </div>
    </div>
  );
}
