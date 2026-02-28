import React, { useState } from 'react';
import { useAppStore } from '../state/store';
import { useContexts, useSetActiveContext, useNamespaces, usePing, useProfiles, useSetActiveProfile, useContextPreflight } from '../state/queries';
import { ContextManager } from './ContextManager';
import { PluginManager } from '../plugins/PluginManager';

export function TopBar() {
  const {
    activeContext,
    activeProfile,
    activeNamespace,
    setActiveProfile,
    setActiveContext,
    setActiveNamespace,
    connected,
    setConnected,
    readOnly,
    setReadOnly,
  } =
    useAppStore();
  const ping = usePing();
  const profiles = useProfiles();
  const contexts = useContexts();
  const [showContextManager, setShowContextManager] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [contextCheckDelayed, setContextCheckDelayed] = useState(false);
  const setContextMutation = useSetActiveContext();
  const setProfileMutation = useSetActiveProfile();
  const namespaces = useNamespaces(activeContext);
  const preflight = useContextPreflight(activeContext);
  const daemonConnected = ping.isSuccess;
  const contextUnreachable = !!activeContext && daemonConnected && namespaces.isError;
  const contextChecking = !!activeContext && daemonConnected && namespaces.isFetching && !namespaces.isError;
  const contextSlow = contextChecking && contextCheckDelayed;
  const missingExecHelper = !!activeContext && daemonConnected && preflight.data?.missing_exec_helper;
  const missingExecCommand = preflight.data?.exec_command || '';
  const contextErrorDetail =
    namespaces.error instanceof Error ? namespaces.error.message : 'Failed to reach the selected context';
  const statusClass = !daemonConnected ? 'disconnected' : contextUnreachable || contextSlow || missingExecHelper ? 'warning' : 'connected';
  const activeProfileColor =
    profiles.data?.profiles.find((p) => p.name === activeProfile)?.color ||
    profiles.data?.active_profile_color ||
    '';
  const appIconSrc = React.useMemo(() => new URL('icon.png', window.location.href).toString(), []);

  React.useEffect(() => {
    setConnected(ping.isSuccess);
  }, [ping.isSuccess, setConnected]);

  // Global keyboard shortcut: Cmd+, (all platforms) → open Preferences.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        setShowPreferences(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  React.useEffect(() => {
    if (!contextChecking) {
      setContextCheckDelayed(false);
      return;
    }
    const t = setTimeout(() => setContextCheckDelayed(true), 3000);
    return () => clearTimeout(t);
  }, [contextChecking, activeContext]);

  React.useEffect(() => {
    const fromBackend = profiles.data?.active_profile || '';
    if (fromBackend && fromBackend !== activeProfile) {
      setActiveProfile(fromBackend);
    }
  }, [profiles.data?.active_profile, activeProfile, setActiveProfile]);

  // Auto-select active context on load/profile switch and clear stale selections.
  React.useEffect(() => {
    if (contexts.data) {
      const active = contexts.data.contexts.find((c) => c.isActive);
      const names = new Set(contexts.data.contexts.map((c) => c.name));
      if (!activeContext || !names.has(activeContext)) {
        if (active) {
          setActiveContext(active.name);
        } else if (contexts.data.contexts.length > 0) {
          setActiveContext(contexts.data.contexts[0].name);
        } else {
          setActiveContext('');
        }
      }
    }
  }, [contexts.data, activeContext, setActiveContext]);

  const handleContextChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value;
    setActiveContext(name);
    setContextMutation.mutate(name);
  };

  const handleNamespaceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setActiveNamespace(e.target.value);
  };

  const handleProfileChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value;
    setActiveProfile(name);
    setActiveContext('');
    setActiveNamespace('');
    setProfileMutation.mutate(name, {
      onSuccess: () => {
        profiles.refetch();
        contexts.refetch();
        const api = (window as any).electronAPI;
        if (api?.sessionBroadcast) void api.sessionBroadcast('profile-changed');
      },
      onError: () => {
        profiles.refetch();
        contexts.refetch();
      },
    });
  };

  return (
    <>
    {showContextManager && (
      <ContextManager
        onClose={() => setShowContextManager(false)}
        onContextsChanged={() => contexts.refetch()}
        onProfilesChanged={() => profiles.refetch()}
      />
    )}
    {showPreferences && (
      <PluginManager onClose={() => setShowPreferences(false)} />
    )}
    <div className={`top-bar ${!readOnly ? 'write-mode' : ''}`}>
      <div className="top-bar-left">
        <img className="app-icon" src={appIconSrc} alt="" aria-hidden="true" />
        <span className={`status-dot ${statusClass}`} />
        <span className="app-title">Truss</span>
        <select
          className="topbar-profile-select"
          title="Active profile"
          aria-label="Active profile"
          value={activeProfile || 'default'}
          onChange={handleProfileChange}
          disabled={!profiles.data || setProfileMutation.isPending}
          style={
            activeProfileColor
              ? ({
                  '--profile-color': activeProfileColor,
                } as React.CSSProperties)
              : undefined
          }
        >
          {profiles.data?.profiles.map((profile) => (
            <option key={profile.name} value={profile.name}>
              {profile.name}
            </option>
          ))}
        </select>
        {(contextUnreachable || contextSlow) && (
          <button
            className="topbar-network-alert"
            onClick={() => namespaces.refetch()}
            title={contextUnreachable ? contextErrorDetail : 'Still checking context connectivity'}
          >
            <span className="topbar-network-alert-icon">{contextUnreachable ? '!' : '\u2026'}</span>
            <span className="topbar-network-alert-text">
              {contextUnreachable ? 'Context unreachable' : 'Checking context connectivity'}
            </span>
            <span className="topbar-network-alert-action">Retry</span>
          </button>
        )}
        {missingExecHelper && (
          <button
            className="topbar-network-alert"
            onClick={() => preflight.refetch()}
            title={preflight.data?.message || `Missing auth helper: ${missingExecCommand}`}
          >
            <span className="topbar-network-alert-icon">!</span>
            <span className="topbar-network-alert-text">
              Missing auth helper: {missingExecCommand}
            </span>
            <span className="topbar-network-alert-action">Check</span>
          </button>
        )}
        {!readOnly && (
          <span className="write-mode-bubble" title="Write mode enabled: mutating actions are allowed">
            Write Mode
          </span>
        )}
      </div>
      <div className="top-bar-center">
        <label>
          Context:
          <select aria-label="Active Kubernetes context" value={activeContext} onChange={handleContextChange} disabled={!contexts.data}>
            {contexts.data?.contexts.map((ctx) => (
              <option key={ctx.name} value={ctx.name}>
                {ctx.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="topbar-contexts-btn"
          onClick={() => setShowContextManager(true)}
          title="Manage encrypted profiles and contexts"
          aria-haspopup="dialog"
          aria-expanded={showContextManager}
          aria-label="Open vault and context manager"
        >
          ⚙ Vault
        </button>
        <button
          className="topbar-preferences-btn"
          onClick={() => setShowPreferences(true)}
          title="Preferences"
          aria-haspopup="dialog"
          aria-expanded={showPreferences}
          aria-label="Open preferences"
        >
          ⚙ Preferences
        </button>
      </div>
      <div className="top-bar-right">
        <label className="readonly-toggle" title={readOnly ? 'Modify mode: RO (mutations disabled)' : 'Modify mode: Write (mutations enabled)'}>
          <span className="readonly-label">{readOnly ? '\uD83D\uDD12' : '\uD83D\uDD13'} {readOnly ? 'RO' : 'Write'}</span>
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
            aria-label={readOnly ? 'Read-only mode enabled' : 'Write mode enabled'}
          />
        </label>
        <span className="shortcut-hint">Ctrl+P or : Command, / Search</span>
      </div>
    </div>
    </>
  );
}
