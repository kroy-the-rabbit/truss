import React from 'react';
import { useAppStore } from '../state/store';

export function Breadcrumb() {
  const { activeContext, activeNamespace, selectedKindLabel, selectedResource, setSelectedKind, setSelectedResource } =
    useAppStore();

  if (!activeContext) return null;

  return (
    <div className="breadcrumb-bar">
      <span className="breadcrumb-segment breadcrumb-context">{activeContext}</span>
      {activeNamespace && (
        <>
          <span className="breadcrumb-sep">&gt;</span>
          <span
            className="breadcrumb-segment breadcrumb-clickable"
            onClick={() => setSelectedKind(null, '')}
          >
            {activeNamespace}
          </span>
        </>
      )}
      {selectedKindLabel && (
        <>
          <span className="breadcrumb-sep">&gt;</span>
          <span
            className="breadcrumb-segment breadcrumb-clickable"
            onClick={() => setSelectedResource('')}
          >
            {selectedKindLabel}
          </span>
        </>
      )}
      {selectedResource && (
        <>
          <span className="breadcrumb-sep">&gt;</span>
          <span className="breadcrumb-segment breadcrumb-current">{selectedResource}</span>
        </>
      )}
    </div>
  );
}
