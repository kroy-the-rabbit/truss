import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { PluginRecord } from './types';
import { pluginRegistry } from './registry';
import { approvePlugin, denyPlugin, discoverPlugins, loadPlugins } from './loader';
import { registerBuiltins } from './builtin/index';
import { useToast } from '../hooks/useToast';
import { PluginConsentModal } from './PluginConsentModal';

// Register built-in plugins immediately at module load time so they are available
// before the first React render. The double-registration guard in registerBuiltins()
// prevents duplicate registration in React StrictMode.
registerBuiltins();

interface PluginContextValue {
  records: PluginRecord[];
  loading: boolean;
  registry: typeof pluginRegistry;
  reload(): Promise<void>;
  // Approve a third-party plugin (main confirms with a native dialog). Resolves
  // true when the user confirmed and the plugin was enabled.
  approve(record: PluginRecord): Promise<boolean>;
  // Keep a plugin disabled / revoke its approval.
  deny(pluginId: string): Promise<void>;
}

const PluginContext = createContext<PluginContextValue>({
  records: [],
  loading: true,
  registry: pluginRegistry,
  reload: async () => {},
  approve: async () => false,
  deny: async () => {},
});

async function loadExternalPlugins(): Promise<PluginRecord[]> {
  return loadPlugins(await discoverPlugins());
}

export function PluginProvider({ children }: { children: React.ReactNode }) {
  const [records, setRecords] = useState<PluginRecord[]>([]);
  const [loading, setLoading] = useState(true);
  // Plugins awaiting a decision, shown once in the startup consent modal.
  const [consentQueue, setConsentQueue] = useState<PluginRecord[]>([]);
  const consentShown = useRef(false);
  const addToast = useToast((s) => s.addToast);

  const reportFailures = useCallback((r: PluginRecord[]) => {
    const failed = r.filter((rec) => rec.loadError);
    if (failed.length > 0) {
      addToast('warning', `${failed.length} plugin${failed.length > 1 ? 's' : ''} failed to load — check Preferences → Plugins`);
    }
  // addToast is stable (Zustand)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await loadExternalPlugins();
      setRecords(r);
      reportFailures(r);
    } finally {
      setLoading(false);
    }
  }, [reportFailures]);

  const approve = useCallback(async (record: PluginRecord) => {
    let ok = false;
    try {
      ok = await approvePlugin(record);
    } catch (err) {
      addToast('error', `Could not enable plugin "${record.manifest.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ok) {
      setRecords(await discoverPlugins());
    }
    return ok;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deny = useCallback(async (pluginId: string) => {
    try {
      await denyPlugin(pluginId);
    } catch (err) {
      addToast('error', `Could not update plugin "${pluginId}": ${err instanceof Error ? err.message : String(err)}`);
    }
    setRecords(await discoverPlugins());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadExternalPlugins()
      .then((r) => {
        setRecords(r);
        reportFailures(r);
        if (!consentShown.current) {
          consentShown.current = true;
          setConsentQueue(r.filter((rec) => !rec.isBuiltin && rec.needsConsent));
        }
      })
      .catch(() => {
        addToast('error', 'Plugin discovery failed — external plugins could not be loaded');
      })
      .finally(() => setLoading(false));
  // addToast is stable (Zustand); omitting from deps is intentional
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PluginContext.Provider value={{ records, loading, registry: pluginRegistry, reload, approve, deny }}>
      {children}
      {consentQueue.length > 0 && (
        <PluginConsentModal
          plugins={consentQueue}
          onApprove={approve}
          onDeny={deny}
          onDone={() => setConsentQueue([])}
        />
      )}
    </PluginContext.Provider>
  );
}

export function usePluginContext() {
  return useContext(PluginContext);
}
