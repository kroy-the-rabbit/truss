import React, { useState, useRef, useEffect } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useAppStore } from '../state/store';
import { useResourceYaml, useApplyYaml } from '../state/queries';
import type { GVR } from '../api/gen/truss/v1/resources_pb';

loader.config({ monaco });

interface Props {
  name: string;
  namespace: string;
  gvr: GVR;
}

export function YamlTab({ name, namespace, gvr }: Props) {
  const { activeContext, readOnly } = useAppStore();
  const yaml = useResourceYaml(activeContext, namespace, gvr, name);
  const applyMutation = useApplyYaml();
  const [editMode, setEditMode] = useState(false);
  const [editedYaml, setEditedYaml] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [externalEditPath, setExternalEditPath] = useState('');
  const [openingExternal, setOpeningExternal] = useState(false);
  const [reloadingExternal, setReloadingExternal] = useState(false);
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const editorPath = `${activeContext}:${gvr.group}/${gvr.version}/${gvr.resource}:${namespace}:${name}.yaml`;

  useEffect(() => {
    if (!editMode && typeof yaml.data?.yaml === 'string') {
      setEditedYaml(yaml.data.yaml);
    }
  }, [yaml.data?.yaml, editMode]);

  useEffect(() => {
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).electronAPI;
      if (externalEditPath) {
        api?.yamlCleanupExternalEditorFile?.(externalEditPath);
      }
    };
  }, [externalEditPath]);

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleToggleEdit = () => {
    if (!editMode && typeof yaml.data?.yaml === 'string') {
      setEditedYaml(yaml.data.yaml);
    }
    if (editMode && externalEditPath) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).electronAPI;
      api?.yamlCleanupExternalEditorFile?.(externalEditPath);
      setExternalEditPath('');
    }
    setEditMode(!editMode);
    setMessage(null);
  };

  const handleOpenExternalEditor = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.yamlOpenExternalEditor) return;
    setOpeningExternal(true);
    setMessage(null);
    try {
      if (externalEditPath) {
        await api.yamlCleanupExternalEditorFile?.(externalEditPath);
      }
      const source = editMode ? editedYaml : (yaml.data?.yaml || '');
      const result = await api.yamlOpenExternalEditor({
        context: activeContext,
        namespace,
        resource: gvr.resource,
        name,
        yaml: source,
      });
      setExternalEditPath(result.filePath || '');
      setEditMode(true);
      setMessage({ type: 'success', text: 'Opened in external editor. Close it, then click "Reload from editor".' });
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to open external editor: ${err}` });
    } finally {
      setOpeningExternal(false);
    }
  };

  const handleReloadFromExternal = async () => {
    if (!externalEditPath) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    setReloadingExternal(true);
    setMessage(null);
    try {
      const content = await api?.yamlReadExternalEditorFile?.(externalEditPath);
      setEditedYaml(typeof content === 'string' ? content : '');
      setEditMode(true);
      await api?.yamlCleanupExternalEditorFile?.(externalEditPath);
      setExternalEditPath('');
      setMessage({ type: 'success', text: 'Reloaded changes from external editor.' });
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to reload external edits: ${err}` });
    } finally {
      setReloadingExternal(false);
    }
  };

  const handleCancelExternalEdit = async () => {
    if (!externalEditPath) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    await api?.yamlCleanupExternalEditorFile?.(externalEditPath);
    setExternalEditPath('');
    setMessage({ type: 'success', text: 'External edit session canceled.' });
  };

  const handleCopyYaml = async () => {
    const content = editMode ? editedYaml : (yaml.data?.yaml || '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    try {
      if (api?.clipboardWriteText) {
        await api.clipboardWriteText(content);
      } else {
        await navigator.clipboard.writeText(content);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleSave = async () => {
    const currentYaml = yaml.data?.yaml || '';
    if (editedYaml === currentYaml) {
      setMessage({ type: 'success', text: 'No changes to save.' });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.openYamlDiffWindow) {
      setMessage({ type: 'error', text: 'YAML diff window is unavailable.' });
      return;
    }
    try {
      const decision = await api.openYamlDiffWindow({
        context: activeContext,
        namespace,
        resource: gvr.resource,
        name,
        currentYaml,
        proposedYaml: editedYaml,
      });
      if (!decision?.approved) {
        setMessage({ type: 'success', text: 'Save canceled.' });
        return;
      }

      const result = await applyMutation.mutateAsync({
        context: activeContext,
        namespace,
        yaml: editedYaml,
      });
      setMessage({ type: 'success', text: result.message });
      setEditMode(false);
      if (typeof result.resultingYaml === 'string' && result.resultingYaml) {
        setEditedYaml(result.resultingYaml);
      }
      if (externalEditPath) {
        await api?.yamlCleanupExternalEditorFile?.(externalEditPath);
        setExternalEditPath('');
      }
      await yaml.refetch();
    } catch (err) {
      setMessage({ type: 'error', text: `Save failed: ${err}` });
    }
  };

  if (yaml.isLoading) {
    return <div className="yaml-tab loading">Loading YAML...</div>;
  }

  if (yaml.isError) {
    return (
      <div className="yaml-tab loading">
        <span style={{ color: 'var(--error)' }}>
          Failed to load YAML: {yaml.error instanceof Error ? yaml.error.message : String(yaml.error)}
        </span>
        <button onClick={() => yaml.refetch()} style={{ marginTop: 8, padding: '4px 12px', background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="yaml-tab">
      <div className="yaml-toolbar">
        <button onClick={handleToggleEdit} className={editMode ? 'active' : ''} disabled={!editMode && readOnly}>
          {editMode ? 'Cancel Edit' : 'Edit YAML'}
        </button>
        <button onClick={handleOpenExternalEditor} disabled={openingExternal || readOnly}>
          {openingExternal ? 'Opening...' : 'Open in Editor'}
        </button>
        <button onClick={handleCopyYaml}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
        {editMode && (
          <>
            <button onClick={handleSave} disabled={readOnly || applyMutation.isPending} className="apply-btn">
              {applyMutation.isPending ? 'Saving...' : 'Save'}
            </button>
          </>
        )}
      </div>
      {externalEditPath && (
        <div className="yaml-external-edit-banner">
          <span className="yaml-external-edit-path">External file: {externalEditPath}</span>
          <button onClick={handleReloadFromExternal} disabled={reloadingExternal}>
            {reloadingExternal ? 'Reloading...' : 'Reload from editor'}
          </button>
          <button onClick={handleCancelExternalEdit}>Cancel</button>
        </div>
      )}
      {message && (
        <div className={`yaml-message ${message.type}`}>
          <pre>{message.text}</pre>
          <button onClick={() => setMessage(null)}>Dismiss</button>
        </div>
      )}
      <div className="yaml-editor">
        <Editor
          path={editorPath}
          height="100%"
          language="yaml"
          theme="vs-dark"
          value={editMode ? editedYaml : yaml.data?.yaml || ''}
          onChange={(value) => {
            if (editMode && value !== undefined) {
              setEditedYaml(value);
            }
          }}
          onMount={handleEditorMount}
          loading={<div style={{ padding: 20, color: 'var(--text-dim)' }}>Loading editor...</div>}
          options={{
            readOnly: !editMode,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
