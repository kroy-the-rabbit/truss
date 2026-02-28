import type { Resource } from '../api/gen/truss/v1/resources_pb';
import type { GVR } from '../api/gen/truss/v1/resources_pb';
import type { PluginResource } from './types';

// Converts a proto-generated Resource class to the plain PluginResource interface
// that plugins work with. This avoids exposing the proto class to external plugins.
export function toPluginResource(resource: Resource, gvr?: GVR | null): PluginResource {
  return {
    name: resource.metadata?.name ?? '',
    namespace: resource.metadata?.namespace ?? '',
    kind: resource.kind,
    apiVersion: resource.apiVersion,
    gvr: {
      group: gvr?.group ?? '',
      version: gvr?.version ?? '',
      resource: gvr?.resource ?? '',
    },
    summary: resource.summary.map((f) => ({ key: f.key, value: f.value })),
    conditions: resource.conditions.map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason || undefined,
      message: c.message || undefined,
    })),
    metadata: {
      uid: resource.metadata?.uid ?? '',
      labels: { ...resource.metadata?.labels },
      annotations: { ...resource.metadata?.annotations },
      creationTimestamp: resource.metadata?.creationTimestamp ?? '',
    },
  };
}
