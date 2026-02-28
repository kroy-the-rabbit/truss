import React from 'react';
import { ResourceTree } from '../components/ResourceTree';
import { useAppStore } from '../state/store';

export function TreeSidebar() {
  const { activePane } = useAppStore();
  const isFocused = activePane === 'navigator';

  return (
    <div className={`pane sidebar ${isFocused ? 'focused' : ''}`}>
      <div className="pane-header">Resources</div>
      <div className="sidebar-tree-content">
        <ResourceTree />
      </div>
    </div>
  );
}
