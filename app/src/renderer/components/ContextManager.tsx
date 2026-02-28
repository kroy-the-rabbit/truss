import React, { useState, useEffect } from 'react';
import { fetchSetupAPI } from '../api/client';
import { useContexts, useProfiles } from '../state/queries';
import { useAppStore } from '../state/store';
import { Modal } from './Modal';
import { useToast } from '../hooks/useToast';

interface Props {
  onClose: () => void;
  onContextsChanged: () => void;
  onProfilesChanged: () => void;
}

interface SystemContext {
  name: string;
  cluster: string;
  user: string;
}

export function ContextManager({ onClose, onContextsChanged, onProfilesChanged }: Props) {
  const storedQuery = useContexts();
  const profilesQuery = useProfiles();
  const storedContexts = storedQuery.data?.contexts ?? [];
  const { activeProfile, setActiveProfile } = useAppStore();
  const addToast = useToast((s) => s.addToast);

  const [systemContexts, setSystemContexts] = useState<SystemContext[]>([]);
  const [systemLoading, setSystemLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [profileName, setProfileName] = useState('');
  const [profileError, setProfileError] = useState('');
  const [renameFrom, setRenameFrom] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [profileColor, setProfileColor] = useState('');
  const [confirmDeleteProfile, setConfirmDeleteProfile] = useState<string | null>(null);

  const [showPaste, setShowPaste] = useState(false);
  const [pasteYaml, setPasteYaml] = useState('');
  const [pasteName, setPasteName] = useState('');
  const [pasteDisplayName, setPasteDisplayName] = useState('');
  const [pasteError, setPasteError] = useState('');
  const [pasteImporting, setPasteImporting] = useState(false);

  useEffect(() => {
    setSystemLoading(true);
    fetchSetupAPI('/api/kubeconfig-contexts')
      .then((r) => r.json())
      .then((data) => setSystemContexts(data.contexts || []))
      .catch(() => setSystemContexts([]))
      .finally(() => setSystemLoading(false));
  }, []);

  const storedNames = new Set(storedContexts.map((c) => c.name));

  useEffect(() => {
    const backendActive = profilesQuery.data?.active_profile;
    if (backendActive && backendActive !== activeProfile) {
      setActiveProfile(backendActive);
    }
    if (!renameFrom && profilesQuery.data?.profiles.length) {
      setRenameFrom(backendActive || profilesQuery.data.profiles[0].name);
    }
    const activeColor = profilesQuery.data?.profiles.find((p) => p.name === (backendActive || activeProfile))?.color || '';
    setProfileColor(activeColor || '');
  }, [profilesQuery.data, activeProfile, setActiveProfile, renameFrom]);

  const switchProfile = async (name: string) => {
    setProfileError('');
    try {
      const resp = await fetchSetupAPI('/api/profiles/set-active', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setProfileError((data as { error?: string }).error || 'Failed to switch profile');
        return;
      }
      setActiveProfile(name);
      profilesQuery.refetch();
      storedQuery.refetch();
      onProfilesChanged();
      onContextsChanged();
    } catch (err) {
      setProfileError(`Error: ${err}`);
    }
  };

  const handleImportSystem = async (ctx: SystemContext) => {
    setImportError('');
    setImporting(ctx.name);
    try {
      const resp = await fetchSetupAPI('/api/contexts/import', {
        method: 'POST',
        body: JSON.stringify({ name: ctx.name, system_context: ctx.name }),
      });
      if (resp.ok) {
        storedQuery.refetch();
        onContextsChanged();
      } else {
        const data = await resp.json().catch(() => ({}));
        setImportError((data as { error?: string }).error || 'Import failed');
      }
    } catch (err) {
      setImportError(`Error: ${err}`);
    } finally {
      setImporting(null);
    }
  };

  const handleDelete = async (name: string) => {
    if (confirmDelete !== name) {
      setConfirmDelete(name);
      return;
    }
    try {
      const resp = await fetchSetupAPI('/api/contexts/delete', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (resp.ok) {
        setConfirmDelete(null);
        storedQuery.refetch();
        onContextsChanged();
      }
    } catch (err) {
      addToast('error', `Failed to delete context: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handlePasteImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasteError('');
    if (!pasteName.trim()) { setPasteError('Name required.'); return; }
    if (!pasteYaml.trim()) { setPasteError('Paste kubeconfig YAML.'); return; }
    setPasteImporting(true);
    try {
      const resp = await fetchSetupAPI('/api/contexts/import', {
        method: 'POST',
        body: JSON.stringify({
          name: pasteName.trim(),
          display_name: pasteDisplayName.trim(),
          kubeconfig: pasteYaml.trim(),
        }),
      });
      if (resp.ok) {
        setPasteName('');
        setPasteDisplayName('');
        setPasteYaml('');
        setShowPaste(false);
        storedQuery.refetch();
        onContextsChanged();
      } else {
        const data = await resp.json().catch(() => ({}));
        setPasteError((data as { error?: string }).error || 'Import failed');
      }
    } catch (err) {
      setPasteError(`Error: ${err}`);
    } finally {
      setPasteImporting(false);
    }
  };

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileError('');
    if (!profileName.trim()) {
      setProfileError('Profile name required.');
      return;
    }
    try {
      const resp = await fetchSetupAPI('/api/profiles/create', {
        method: 'POST',
        body: JSON.stringify({ name: profileName.trim() }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setProfileError((data as { error?: string }).error || 'Create failed');
        return;
      }
      setProfileName('');
      profilesQuery.refetch();
      onProfilesChanged();
    } catch (err) {
      setProfileError(`Error: ${err}`);
    }
  };

  const handleRenameProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileError('');
    if (!renameFrom.trim() || !renameTo.trim()) {
      setProfileError('Both profile names are required.');
      return;
    }
    try {
      const resp = await fetchSetupAPI('/api/profiles/rename', {
        method: 'POST',
        body: JSON.stringify({ old_name: renameFrom.trim(), new_name: renameTo.trim() }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setProfileError((data as { error?: string }).error || 'Rename failed');
        return;
      }
      if (activeProfile === renameFrom.trim()) setActiveProfile(renameTo.trim());
      setRenameTo('');
      profilesQuery.refetch();
      storedQuery.refetch();
      onProfilesChanged();
      onContextsChanged();
    } catch (err) {
      setProfileError(`Error: ${err}`);
    }
  };

  const handleDeleteProfile = async (name: string) => {
    if (confirmDeleteProfile !== name) {
      setConfirmDeleteProfile(name);
      return;
    }
    setProfileError('');
    try {
      const resp = await fetchSetupAPI('/api/profiles/delete', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setProfileError((data as { error?: string }).error || 'Delete failed');
        return;
      }
      setConfirmDeleteProfile(null);
      profilesQuery.refetch();
      storedQuery.refetch();
      onProfilesChanged();
      onContextsChanged();
    } catch (err) {
      setProfileError(`Error: ${err}`);
    }
  };

  const handleSetProfileColor = async (name: string, color: string) => {
    setProfileError('');
    try {
      const resp = await fetchSetupAPI('/api/profiles/set-color', {
        method: 'POST',
        body: JSON.stringify({ name, color }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setProfileError((data as { error?: string }).error || 'Failed to set profile color');
        return;
      }
      setProfileColor(color);
      profilesQuery.refetch();
      onProfilesChanged();
    } catch (err) {
      setProfileError(`Error: ${err}`);
    }
  };

  const profilePalette = ['#5b8def', '#3aa99f', '#c77dff', '#f4a259', '#e76f51', '#8ab17d', '#7f90a0', ''];

  return (
    <Modal
      onClose={onClose}
      labelledBy="context-manager-title"
      contentClassName="modal-content context-manager"
      initialFocusSelector=".modal-close"
    >
        <div className="modal-header">
          <h2 id="context-manager-title">Manage Profiles & Contexts</h2>
          <button className="modal-close" aria-label="Close context manager" onClick={onClose}>×</button>
        </div>

        <div className="cm-profiles">
          <div className="cm-profiles-row">
            <label>
              Active Profile:
              <select
                value={activeProfile}
                onChange={(e) => {
                  const next = e.target.value;
                  setProfileColor(profilesQuery.data?.profiles.find((p) => p.name === next)?.color || '');
                  void switchProfile(next);
                }}
                disabled={!profilesQuery.data}
              >
                {profilesQuery.data?.profiles.map((profile) => (
                  <option key={profile.name} value={profile.name}>{profile.name}</option>
                ))}
              </select>
            </label>
            <span
              className="cm-active-profile-pill"
              style={
                profileColor
                  ? ({
                      '--profile-color': profileColor,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              {activeProfile}
            </span>
          </div>
          <div className="cm-profiles-row cm-profile-color-row">
            <label>
              Profile Color:
              <input
                type="color"
                className="cm-color-input"
                value={profileColor || '#5b8def'}
                onChange={(e) => void handleSetProfileColor(activeProfile, e.target.value)}
              />
            </label>
            <div className="cm-color-swatches">
              {profilePalette.map((color) => (
                <button
                  key={color || 'none'}
                  className={`cm-color-swatch ${!color ? 'none' : ''}`}
                  style={color ? { backgroundColor: color } : undefined}
                  onClick={() => void handleSetProfileColor(activeProfile, color)}
                  title={color || 'Clear color'}
                  aria-label={color ? `Set profile color ${color}` : 'Clear profile color'}
                  type="button"
                >
                  {!color ? '×' : ''}
                </button>
              ))}
            </div>
          </div>
          <form className="cm-profiles-row" onSubmit={handleCreateProfile}>
            <input
              type="text"
              className="setup-input"
              placeholder="New profile name"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
            />
            <button type="submit" className="cm-btn-import">+ Create</button>
          </form>
          <form className="cm-profiles-row" onSubmit={handleRenameProfile}>
            <select className="setup-input" value={renameFrom} onChange={(e) => setRenameFrom(e.target.value)}>
              {(profilesQuery.data?.profiles || []).map((profile) => (
                <option key={profile.name} value={profile.name}>{profile.name}</option>
              ))}
            </select>
            <input
              type="text"
              className="setup-input"
              placeholder="Rename to…"
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
            />
            <button type="submit" className="cm-btn-import">Rename</button>
          </form>
          <div className="cm-profiles-row cm-profiles-delete-list">
            {(profilesQuery.data?.profiles || []).map((profile) => (
              <button
                key={profile.name}
                className={`cm-btn-delete ${confirmDeleteProfile === profile.name ? 'cm-btn-delete-confirm' : ''}`}
                onClick={() => void handleDeleteProfile(profile.name)}
                title={confirmDeleteProfile === profile.name ? 'Click again to confirm' : 'Delete profile'}
              >
                {confirmDeleteProfile === profile.name ? `Delete ${profile.name}?` : `Delete ${profile.name}`}
              </button>
            ))}
          </div>
          {profileError && <div className="cm-error" role="alert">{profileError}</div>}
        </div>

        <div className="cm-columns">
          {/* Left: ~/.kube/config */}
          <div className="cm-col">
            <div className="cm-col-header">
              <span className="cm-col-title">~/.kube/config</span>
              {!systemLoading && <span className="cm-col-count">{systemContexts.length}</span>}
            </div>
            <div className="cm-list">
              {systemLoading && <div className="cm-empty">Loading…</div>}
              {!systemLoading && systemContexts.length === 0 && (
                <div className="cm-empty">No contexts found</div>
              )}
              {systemContexts.map((ctx) => {
                const alreadyImported = storedNames.has(ctx.name);
                return (
                  <div key={ctx.name} className={`cm-item ${alreadyImported ? 'cm-item-imported' : ''}`}>
                    <div className="cm-item-info">
                      <span className="cm-item-name" title={ctx.name}>{ctx.name}</span>
                      <span className="cm-item-sub" title={ctx.cluster}>{ctx.cluster}</span>
                    </div>
                    {alreadyImported ? (
                      <span className="cm-badge-imported">✓ stored</span>
                    ) : (
                      <button
                        className="cm-btn-import"
                        onClick={() => handleImportSystem(ctx)}
                        disabled={importing === ctx.name}
                        title="Copy to encrypted store"
                      >
                        {importing === ctx.name ? '…' : '→ Add'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="cm-col-divider" />

          {/* Right: encrypted store */}
          <div className="cm-col">
            <div className="cm-col-header">
              <span className="cm-col-title">Encrypted Store</span>
              <span className="cm-col-count">{storedContexts.length}</span>
            </div>
            <div className="cm-list">
              {storedContexts.length === 0 && (
                <div className="cm-empty">No contexts yet<br /><span className="cm-empty-hint">Import from ~/.kube/config →</span></div>
              )}
              {storedContexts.map((ctx) => (
                <div key={ctx.name} className="cm-item">
                  <div className="cm-item-info">
                    <span className="cm-item-name" title={ctx.name}>{ctx.name}</span>
                    {ctx.isActive && <span className="cm-badge-active">active</span>}
                  </div>
                  <button
                    className={`cm-btn-delete ${confirmDelete === ctx.name ? 'cm-btn-delete-confirm' : ''}`}
                    onClick={() => handleDelete(ctx.name)}
                    title={confirmDelete === ctx.name ? 'Click again to confirm' : 'Remove from store'}
                  >
                    {confirmDelete === ctx.name ? 'Confirm' : '×'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {importError && <div className="cm-error" role="alert">{importError}</div>}

        {/* Paste YAML */}
        <div className="cm-paste-section">
          <button
            className="cm-paste-toggle"
            type="button"
            onClick={() => setShowPaste((v) => !v)}
            aria-expanded={showPaste}
            aria-controls="context-manager-paste-form"
          >
            {showPaste ? '▾' : '▸'} Add via kubeconfig YAML
          </button>
          {showPaste && (
            <form id="context-manager-paste-form" onSubmit={handlePasteImport} className="cm-paste-form">
              <div className="cm-paste-row">
                <input
                  type="text"
                  className="setup-input"
                  placeholder="Store key (e.g. prod)"
                  value={pasteName}
                  onChange={(e) => setPasteName(e.target.value)}
                />
                <input
                  type="text"
                  className="setup-input"
                  placeholder="Display name (optional)"
                  value={pasteDisplayName}
                  onChange={(e) => setPasteDisplayName(e.target.value)}
                />
              </div>
              <textarea
                className="setup-input setup-textarea"
                value={pasteYaml}
                onChange={(e) => setPasteYaml(e.target.value)}
                placeholder="Paste kubeconfig YAML…"
                rows={5}
                spellCheck={false}
              />
              {pasteError && <div className="setup-error" role="alert">{pasteError}</div>}
              <button type="submit" className="setup-btn-primary" disabled={pasteImporting}>
                {pasteImporting ? 'Importing…' : 'Import'}
              </button>
            </form>
          )}
        </div>
    </Modal>
  );
}
