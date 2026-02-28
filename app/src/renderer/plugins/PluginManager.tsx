import React, { useState } from 'react';
import { usePluginContext } from './context';
import type { PluginRecord } from './types';
import { useThemeExtensions } from './hooks';
import { useAppStore } from '../state/store';
import { fetchSetupAPI } from '../api/client';
import { Modal } from '../components/Modal';
import { DEFAULT_EVENT_SUPPRESSION_RULE_LINES } from '../lib/eventFilters';
import { useToast } from '../hooks/useToast';

interface Props {
  onClose(): void;
}

function CapabilityBadge({ cap }: { cap: string }) {
  return <span className="plugin-badge">{cap}</span>;
}

function PluginCard({ record }: { record: PluginRecord }) {
  const [toggling, setToggling] = useState(false);
  const { reload } = usePluginContext();

  const handleToggle = async () => {
    if (record.isBuiltin) return;
    setToggling(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).electronAPI?.pluginSetEnabled?.(record.manifest.id, !record.enabled);
      await reload();
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className={`plugin-card ${!record.enabled ? 'plugin-card-disabled' : ''}`}>
      <div className="plugin-card-header">
        <div className="plugin-card-title">
          <span className="plugin-name">{record.manifest.name}</span>
          <span className="plugin-version">v{record.manifest.version}</span>
          {record.isBuiltin && <span className="plugin-badge plugin-badge-builtin">built-in</span>}
        </div>
        <label className="plugin-toggle" title={record.isBuiltin ? 'Built-in plugins cannot be disabled' : ''}>
          <input
            type="checkbox"
            checked={record.enabled}
            disabled={record.isBuiltin || toggling}
            onChange={handleToggle}
          />
          <span className="plugin-toggle-label">{record.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      {record.manifest.description && (
        <p className="plugin-description">{record.manifest.description}</p>
      )}

      <div className="plugin-capabilities">
        {record.manifest.capabilities.map((cap) => (
          <CapabilityBadge key={cap} cap={cap} />
        ))}
      </div>

      {record.manifest.author && (
        <div className="plugin-meta">by {record.manifest.author}</div>
      )}

      {record.loadError && (
        <div className="plugin-load-error">Load error: {record.loadError}</div>
      )}
    </div>
  );
}

export function PluginManager({ onClose }: Props) {
  const { records, loading } = usePluginContext();
  const {
    themeMode,
    setThemeMode,
    autoLockMinutes,
    setAutoLockMinutes,
    neverConfirmStartupBypass,
    setNeverConfirmStartupBypass,
    eventSuppressionRules,
    setEventSuppressionRules,
  } = useAppStore();
  const themeExtensions = useThemeExtensions();
  const addToast = useToast((s) => s.addToast);
  const [execPathHintsText, setExecPathHintsText] = useState('');
  const [execPathHintsSaved, setExecPathHintsSaved] = useState(false);
  const [eventRulesText, setEventRulesText] = useState('');
  const [eventRulesSaved, setEventRulesSaved] = useState(false);

  const openPluginDir = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI?.openPluginDirectory?.();
  };

  const handleThemeChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const mode = e.target.value;
    setThemeMode(mode);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.setThemeMode) return;
    const ext = themeExtensions.find((t) => t.id === mode);
    const tone = ext?.tone ?? (mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : undefined);
    try {
      await api.setThemeMode(mode, tone);
    } catch (err) {
      addToast('error', 'Failed to save theme preference');
    }
  };

  const handleAutoLockChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const minutes = Number(e.target.value);
    setAutoLockMinutes(minutes);
    try {
      const resp = await fetchSetupAPI('/api/setup/preferences/auto-lock', {
        method: 'POST',
        body: JSON.stringify({ auto_lock_minutes: minutes }),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (err) {
      addToast('error', 'Failed to save auto-lock preference');
    }
  };

  const handleNeverConfirmBypassChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const bypass = e.target.checked;
    setNeverConfirmStartupBypass(bypass);
    try {
      const resp = await fetchSetupAPI('/api/setup/preferences/never-confirm-bypass', {
        method: 'POST',
        body: JSON.stringify({ never_confirm_startup_bypass: bypass }),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (err) {
      addToast('error', 'Failed to save startup preference');
    }
  };

  React.useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.getPreferences) return;
    api.getPreferences()
      .then((prefs: { execPathHints?: string[] }) => {
        const hints = Array.isArray(prefs.execPathHints) ? prefs.execPathHints : [];
        setExecPathHintsText(hints.join('\n'));
        const rules = Array.isArray((prefs as { eventSuppressionRules?: string[] }).eventSuppressionRules)
          ? (prefs as { eventSuppressionRules?: string[] }).eventSuppressionRules!
          : eventSuppressionRules;
        setEventRulesText((rules.length > 0 ? rules : DEFAULT_EVENT_SUPPRESSION_RULE_LINES).join('\n'));
      })
      .catch(() => {
        // keep empty if unavailable
      });
  }, [eventSuppressionRules]);

  const handleExecPathHintsSave = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.setExecPathHints) return;
    const hints = execPathHintsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      await api.setExecPathHints(hints);
      setExecPathHintsSaved(true);
      setTimeout(() => setExecPathHintsSaved(false), 1500);
    } catch (err) {
      addToast('error', 'Failed to save exec PATH hints');
    }
  };

  const handleEventRulesSave = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.setEventSuppressionRules) return;
    const rules = eventRulesText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      const res = await api.setEventSuppressionRules(rules);
      const next = Array.isArray(res?.eventSuppressionRules) ? res.eventSuppressionRules : rules;
      setEventSuppressionRules(next);
      setEventRulesText(next.join('\n'));
      setEventRulesSaved(true);
      setTimeout(() => setEventRulesSaved(false), 1500);
    } catch (err) {
      addToast('error', 'Failed to save event suppression rules');
    }
  };

  const builtins = records.filter((r) => r.isBuiltin);
  const external = records.filter((r) => !r.isBuiltin);

  return (
    <Modal
      onClose={onClose}
      labelledBy="plugin-manager-title"
      overlayClassName="plugin-manager-overlay"
      contentClassName="plugin-manager"
      initialFocusSelector=".plugin-manager-close"
    >
        <div className="plugin-manager-header">
          <h2 id="plugin-manager-title" className="plugin-manager-title">Preferences</h2>
          <button className="plugin-manager-close" onClick={onClose} title="Close" aria-label="Close preferences">✕</button>
        </div>

        <div className="plugin-manager-body">
          <section className="plugin-section">
            <h3 className="plugin-section-title">Appearance</h3>
            <label className="preferences-field">
              Theme
              <select className="preferences-select" value={themeMode} onChange={handleThemeChange}>
                <option value="system">System</option>
                <optgroup label="Themes">
                  {themeExtensions.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </optgroup>
                <option value="user-css">user.css</option>
              </select>
            </label>
            <label className="preferences-field">
              Auto-lock after inactivity
              <select className="preferences-select" value={String(autoLockMinutes)} onChange={handleAutoLockChange}>
                <option value="5">5 minutes</option>
                <option value="10">10 minutes</option>
                <option value="20">20 minutes (Default)</option>
                <option value="30">30 minutes</option>
                <option value="60">60 minutes</option>
                <option value="120">120 minutes</option>
                <option value="0">Never</option>
              </select>
            </label>
            {autoLockMinutes === 0 && (
              <label className="preferences-checkbox-field">
                <input
                  type="checkbox"
                  checked={neverConfirmStartupBypass}
                  onChange={handleNeverConfirmBypassChange}
                />
                Skip startup "Are you sure?" confirmation
              </label>
            )}
          </section>

          <section className="plugin-section">
            <h3 className="plugin-section-title">Connectivity</h3>
            <label className="preferences-field">
              Exec PATH Hints (one directory per line)
              <textarea
                className="preferences-textarea"
                value={execPathHintsText}
                onChange={(e) => setExecPathHintsText(e.target.value)}
                placeholder="/opt/homebrew/bin&#10;/usr/local/bin&#10;/home/user/google-cloud-sdk/bin"
                rows={5}
              />
            </label>
            <div className="preferences-actions">
              <button className="plugin-open-dir-btn" onClick={handleExecPathHintsSave}>Save PATH Hints</button>
              <span className="preferences-hint">
                Applies on next launch. Use this when kube auth helper binaries are not found.
              </span>
              {execPathHintsSaved && <span className="preferences-saved">Saved</span>}
            </div>
          </section>

          <section className="plugin-section">
            <h3 className="plugin-section-title">Event Noise Controls</h3>
            <label className="preferences-field">
              Suppression rules (one per line, format `Kind:Reason`, `*` wildcard allowed)
              <textarea
                className="preferences-textarea"
                value={eventRulesText}
                onChange={(e) => setEventRulesText(e.target.value)}
                placeholder={DEFAULT_EVENT_SUPPRESSION_RULE_LINES.join('\n')}
                rows={6}
                spellCheck={false}
              />
            </label>
            <div className="preferences-actions">
              <button className="plugin-open-dir-btn" onClick={handleEventRulesSave}>Save Event Rules</button>
              <button
                className="plugin-open-dir-btn"
                onClick={() => setEventRulesText(DEFAULT_EVENT_SUPPRESSION_RULE_LINES.join('\n'))}
                type="button"
              >
                Reset Defaults
              </button>
              <span className="preferences-hint">
                Applies to the Events tab and cluster overview warnings.
              </span>
              {eventRulesSaved && <span className="preferences-saved">Saved</span>}
            </div>
          </section>

          {loading ? (
            <div className="plugin-manager-loading">Loading plugins...</div>
          ) : (
            <>
              <section className="plugin-section">
                <h3 className="plugin-section-title">Plugins: Built-in</h3>
                {builtins.length === 0 ? (
                  <p className="plugin-section-empty">No built-in plugins.</p>
                ) : (
                  builtins.map((r) => <PluginCard key={r.manifest.id} record={r} />)
                )}
              </section>

              <section className="plugin-section">
                <h3 className="plugin-section-title">
                  Plugins: External
                  <button
                    className="plugin-open-dir-btn"
                    onClick={openPluginDir}
                    title="Open plugin directory in file manager"
                  >
                    Open Directory
                  </button>
                </h3>
                {external.length === 0 ? (
                  <p className="plugin-section-empty">
                    No external plugins installed. Drop plugin folders into the plugins directory.
                  </p>
                ) : (
                  external.map((r) => <PluginCard key={r.manifest.id} record={r} />)
                )}
              </section>
            </>
          )}
        </div>
    </Modal>
  );
}
