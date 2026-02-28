import type { PluginRegistrar, PluginResource, HealthCategory } from '../types';

// The default health classifier — same logic as the old private classifyHealth()
// in ResourceList.tsx, extracted here so it can be overridden by user plugins
// (register a classifier with higher priority).
export function registerHealthClassifier(registrar: PluginRegistrar): void {
  registrar.registerHealthClassifier({
    id: 'builtin.healthClassifier',
    priority: 0, // default priority; user plugins should use positive values to override
    classify(resource: PluginResource): HealthCategory | null {
      const summary = resource.summary;

      // Check succeeded/failed for Jobs first — a succeeded Job has Ready=0/1
      // which would otherwise look like an error.
      const failed = summary.find((f) => f.key === 'Failed');
      const succeeded = summary.find((f) => f.key === 'Succeeded');
      if (failed && parseInt(failed.value) > 0) return 'err';
      if (succeeded && parseInt(succeeded.value) > 0) return 'ok';

      // Check status text
      const status = summary.find((f) => f.key === 'Status' || f.key === 'Phase');
      if (status) {
        const v = status.value.toLowerCase();
        if (v === 'succeeded' || v === 'completed') return 'ok';
        if (
          v === 'failed' ||
          v === 'error' ||
          v === 'crashloopbackoff' ||
          v === 'imagepullbackoff' ||
          v === 'evicted' ||
          v === 'oomkilled'
        )
          return 'err';
        if (
          v === 'pending' ||
          v === 'waiting' ||
          v === 'containercreating' ||
          v === 'terminating' ||
          v === 'terminated' ||
          v === 'unknown'
        )
          return 'warn';
      }

      // Check ready fraction
      const ready = summary.find((f) => f.key === 'Ready');
      if (ready) {
        const m = ready.value.match(/^(\d+)\/(\d+)$/);
        if (m) {
          const [, a, b] = m;
          if (a === '0' && b !== '0') return 'err';
          if (a !== b) return 'warn';
        }
      }

      return 'ok';
    },
  });
}
