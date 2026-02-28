import React from 'react';
import { useAppStore } from '../state/store';
import { useOwnedPods } from '../state/queries';
import { GVR } from '../api/gen/truss/v1/resources_pb';
import type { Resource } from '../api/gen/truss/v1/resources_pb';

interface Props {
  kind: string;
  name: string;
  namespace: string;
}

function statusClass(value: string): string {
  const v = value.toLowerCase();
  if (v === 'running') return 'status-ok';
  if (v === 'succeeded' || v === 'completed') return 'status-ok';
  if (v === 'pending' || v === 'containercreating') return 'status-warn';
  if (v === 'failed' || v === 'crashloopbackoff' || v === 'imagepullbackoff' || v === 'error') return 'status-err';
  return '';
}

function formatAge(timestamp: string): string {
  if (!timestamp) return '-';
  const created = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getField(res: Resource, key: string): string {
  return res.summary.find((f) => f.key === key)?.value || '';
}

export function PodsTab({ kind, name, namespace }: Props) {
  const { activeContext, setSelectedKind, setSelectedResource } = useAppStore();
  const ownedPods = useOwnedPods(activeContext, namespace, kind, name);
  const pods = ownedPods.data?.pods || [];

  const navigateToPod = (podName: string, podNamespace: string) => {
    setSelectedKind(new GVR({ group: '', version: 'v1', resource: 'pods' }), 'Pod');
    setSelectedResource(podName, podNamespace);
  };

  if (ownedPods.isLoading) {
    return <div className="loading">Loading pods...</div>;
  }

  return (
    <div className="pods-tab">
      <div className="pods-tab-header">
        <h3>Pods ({pods.length})</h3>
      </div>
      <div className="list-table">
        <div className="table-header">
          <span className="col-name">Name</span>
          <span className="col-status">Status</span>
          <span className="col-ready">Ready</span>
          <span className="col-restarts">Restarts</span>
          <span className="col-age">Age</span>
        </div>
        <div className="table-body">
          {pods.length === 0 && (
            <div className="inspector-empty">No pods found</div>
          )}
          {pods.map((pod) => {
            const status = getField(pod, 'Status');
            const ready = getField(pod, 'Ready');
            const restarts = getField(pod, 'Restarts');
            const startedAt = getField(pod, 'StartedAt');
            const age = formatAge(startedAt || pod.metadata?.creationTimestamp || '');
            const cls = statusClass(status);

            return (
              <div
                key={pod.metadata?.uid}
                className="table-row clickable"
                onClick={() => navigateToPod(pod.metadata?.name || '', pod.metadata?.namespace || '')}
              >
                <span className="col-name">{pod.metadata?.name}</span>
                <span className={`col-status ${cls}`}>
                  {cls && <span className={`status-dot-inline ${cls}`} />}
                  {status}
                </span>
                <span className={`col-ready ${statusClass(ready)}`}>{ready || '-'}</span>
                <span className={`col-restarts ${parseInt(restarts) > 0 ? 'status-warn' : ''}`}>
                  {restarts || '0'}
                </span>
                <span className="col-age">{age}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
