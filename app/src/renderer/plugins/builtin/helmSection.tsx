import React from 'react';
import type { PluginRegistrar, TreeSectionProps } from '../types';
import { useAppStore } from '../../state/store';
import { useHelmReleases } from '../../state/queries';

function HelmTreeSection(_props: TreeSectionProps) {
  const { activeContext, activeNamespace, selectedKindLabel, setSelectedKind } = useAppStore();
  const helmReleases = useHelmReleases(activeContext, activeNamespace);
  const isHelmSelected = selectedKindLabel === 'Helm Releases';
  const helmCount = helmReleases.data?.releases?.length ?? 0;

  return (
    <div className="resource-group helm-group">
      <div
        className={`kind-item helm-releases-item ${isHelmSelected ? 'selected' : ''}`}
        onClick={() => setSelectedKind(null, 'Helm Releases')}
      >
        Helm Releases
        {helmCount > 0 && <span className="kind-count">{helmCount}</span>}
      </div>
    </div>
  );
}

export function registerHelmSection(registrar: PluginRegistrar): void {
  registrar.registerTreeSection({
    id: 'builtin.helmSection',
    label: 'Helm Releases',
    order: 100,
    render: (props) => <HelmTreeSection {...props} />,
  });
}
