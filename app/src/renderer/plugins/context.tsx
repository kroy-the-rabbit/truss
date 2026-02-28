import React, { createContext, useContext, useEffect, useState } from 'react';
import type { PluginRecord } from './types';
import { pluginRegistry } from './registry';
import { discoverPlugins, loadPlugin } from './loader';
import { registerBuiltins } from './builtin/index';
import { useToast } from '../hooks/useToast';

// Register built-in plugins immediately at module load time so they are available
// before the first React render. The double-registration guard in registerBuiltins()
// prevents duplicate registration in React StrictMode.
registerBuiltins();

interface PluginContextValue {
  records: PluginRecord[];
  loading: boolean;
  registry: typeof pluginRegistry;
  reload(): Promise<void>;
}

const PluginContext = createContext<PluginContextValue>({
  records: [],
  loading: true,
  registry: pluginRegistry,
  reload: async () => {},
});

async function loadExternalPlugins(): Promise<PluginRecord[]> {
  const discovered = await discoverPlugins();
  const results: PluginRecord[] = [];

  for (const record of discovered) {
    if (!record.enabled) {
      results.push(record);
      continue;
    }
    try {
      await loadPlugin(record);
      results.push(record);
    } catch (err) {
      results.push({ ...record, loadError: String(err) });
    }
  }

  return results;
}

export function PluginProvider({ children }: { children: React.ReactNode }) {
  const [records, setRecords] = useState<PluginRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const addToast = useToast((s) => s.addToast);

  const reload = async () => {
    setLoading(true);
    try {
      const r = await loadExternalPlugins();
      setRecords(r);
      const failed = r.filter((rec) => rec.loadError);
      if (failed.length > 0) {
        addToast('warning', `${failed.length} plugin${failed.length > 1 ? 's' : ''} failed to load — check Preferences → Plugins`);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadExternalPlugins()
      .then((r) => {
        setRecords(r);
        const failed = r.filter((rec) => rec.loadError);
        if (failed.length > 0) {
          addToast('warning', `${failed.length} plugin${failed.length > 1 ? 's' : ''} failed to load — check Preferences → Plugins`);
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
    <PluginContext.Provider value={{ records, loading, registry: pluginRegistry, reload }}>
      {children}
    </PluginContext.Provider>
  );
}

export function usePluginContext() {
  return useContext(PluginContext);
}
