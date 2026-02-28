import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getContextsClient,
  getDiscoveryClient,
  getResourcesClient,
  getYamlClient,
  getHealthClient,
  getHelmClient,
  getOverviewClient,
  fetchSetupAPI,
} from '../api/client';
import type { GVR } from '../api/gen/truss/v1/resources_pb';
import { useAppStore } from './store';

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function fallbackInterval(liveConnected: boolean, disconnectedMs: number, connectedMs = 60000): number {
  return liveConnected ? connectedMs : disconnectedMs;
}

export function usePing() {
  return useQuery({
    queryKey: ['ping'],
    queryFn: async () => {
      const client = await getHealthClient();
      return client.ping({});
    },
    retry: true,
    retryDelay: 1000,
    refetchInterval: 30000,
  });
}

export function useContexts() {
  return useQuery({
    queryKey: ['contexts'],
    queryFn: async () => {
      const client = await getContextsClient();
      return client.listContexts({});
    },
  });
}

export interface ProfilesResponse {
  profiles: Array<{ name: string; color?: string }>;
  active_profile: string;
  active_profile_color?: string;
}

export interface ContextPreflightResponse {
  context?: string;
  has_exec_auth?: boolean;
  missing_exec_helper?: boolean;
  exec_command?: string;
  exec_args?: string[];
  resolved_path?: string;
  message?: string;
  recommendations?: string[];
  error?: string;
}

export function useProfiles() {
  return useQuery({
    queryKey: ['profiles'],
    queryFn: async (): Promise<ProfilesResponse> => {
      const resp = await fetchSetupAPI('/api/profiles');
      if (!resp.ok) throw new Error('Failed to load profiles');
      return resp.json();
    },
  });
}

export function useContextPreflight(context: string) {
  return useQuery({
    queryKey: ['contextPreflight', context],
    queryFn: async (): Promise<ContextPreflightResponse> => {
      const qs = context ? `?context=${encodeURIComponent(context)}` : '';
      const resp = await fetchSetupAPI(`/api/context-preflight${qs}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || 'Failed context preflight');
      }
      return resp.json();
    },
    enabled: !!context,
    refetchInterval: 30000,
  });
}

export function useSetActiveProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const resp = await fetchSetupAPI('/api/profiles/set-active', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Failed to switch profile');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
      queryClient.invalidateQueries({ queryKey: ['contexts'] });
      queryClient.invalidateQueries({ queryKey: ['namespaces'] });
      queryClient.invalidateQueries({ queryKey: ['resourceKinds'] });
      queryClient.invalidateQueries({ queryKey: ['resources'] });
      queryClient.invalidateQueries({ queryKey: ['resource'] });
    },
  });
}

export function useSetActiveContext() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const client = await getContextsClient();
      return client.setActiveContext({ name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contexts'] });
      queryClient.invalidateQueries({ queryKey: ['namespaces'] });
      queryClient.invalidateQueries({ queryKey: ['resourceKinds'] });
      queryClient.invalidateQueries({ queryKey: ['resources'] });
    },
  });
}

export function useNamespaces(context: string) {
  const liveConnected = useAppStore((s) => s.liveUpdatesConnected);
  return useQuery({
    queryKey: ['namespaces', context],
    queryFn: async () => {
      const client = await getContextsClient();
      return withTimeout(
        client.listNamespaces({ context }),
        8000,
        `Timed out reaching context "${context}"`,
      );
    },
    enabled: !!context,
    refetchInterval: fallbackInterval(liveConnected, 30000, 120000),
  });
}

export function useResourceKinds(context: string) {
  return useQuery({
    queryKey: ['resourceKinds', context],
    queryFn: async () => {
      const client = await getDiscoveryClient();
      return client.listResourceKinds({ context });
    },
    enabled: !!context,
    refetchInterval: 60000,
  });
}

export function useResources(context: string, namespace: string, gvr: GVR | null, filter?: string) {
  const liveConnected = useAppStore((s) => s.liveUpdatesConnected);
  return useQuery({
    queryKey: ['resources', context, namespace, gvr?.group, gvr?.version, gvr?.resource, filter],
    queryFn: async () => {
      const client = await getResourcesClient();
      return client.listResources({
        context,
        namespace,
        gvr: gvr!,
        filter: filter || '',
        limit: 500,
      });
    },
    enabled: !!context && !!gvr,
    refetchInterval: fallbackInterval(liveConnected, 5000),
  });
}

export function useResource(context: string, namespace: string, gvr: GVR | null, name: string) {
  const liveConnected = useAppStore((s) => s.liveUpdatesConnected);
  return useQuery({
    queryKey: ['resource', context, namespace, gvr?.group, gvr?.version, gvr?.resource, name],
    queryFn: async () => {
      const client = await getResourcesClient();
      return client.getResource({
        context,
        namespace,
        gvr: gvr!,
        name,
      });
    },
    enabled: !!context && !!gvr && !!name,
    refetchInterval: fallbackInterval(liveConnected, 5000),
  });
}

export function useResourceYaml(context: string, namespace: string, gvr: GVR | null, name: string) {
  return useQuery({
    queryKey: ['yaml', context, namespace, gvr?.group, gvr?.version, gvr?.resource, name],
    queryFn: async () => {
      const client = await getYamlClient();
      return client.getYaml({
        context,
        namespace,
        gvr: gvr!,
        name,
      });
    },
    enabled: !!context && !!gvr && !!name,
  });
}

export function useApplyYaml() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; namespace: string; yaml: string }) => {
      const client = await getYamlClient();
      return client.applyYaml({
        context: params.context,
        namespace: params.namespace,
        yaml: params.yaml,
        fieldManager: 'truss',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
      queryClient.invalidateQueries({ queryKey: ['resource'] });
      queryClient.invalidateQueries({ queryKey: ['yaml'] });
    },
  });
}

export function useDiffYaml() {
  return useMutation({
    mutationFn: async (params: {
      context: string;
      namespace: string;
      gvr: GVR;
      name: string;
      proposedYaml: string;
    }) => {
      const client = await getYamlClient();
      return client.diffYaml({
        context: params.context,
        namespace: params.namespace,
        gvr: params.gvr,
        name: params.name,
        proposedYaml: params.proposedYaml,
      });
    },
  });
}

export function usePodInfo(context: string, namespace: string, pod: string) {
  const liveConnected = useAppStore((s) => s.liveUpdatesConnected);
  return useQuery({
    queryKey: ['podInfo', context, namespace, pod],
    queryFn: async () => {
      const client = await getResourcesClient();
      return client.getPodInfo({ context, namespace, pod });
    },
    enabled: !!context && !!namespace && !!pod,
    refetchInterval: fallbackInterval(liveConnected, 5000),
  });
}

export function useEvents(context: string, namespace: string, kind: string, name: string, uid?: string) {
  const liveConnected = useAppStore((s) => s.liveUpdatesConnected);
  return useQuery({
    queryKey: ['events', context, namespace, kind, name, uid],
    queryFn: async () => {
      const client = await getResourcesClient();
      return client.listEvents({
        context,
        namespace,
        kind,
        name,
        uid: uid || '',
      });
    },
    enabled: !!context && !!name,
    refetchInterval: fallbackInterval(liveConnected, 10000),
  });
}

export function useLogs(
  context: string,
  namespace: string,
  pod: string,
  container: string,
  opts?: {
    tailLines?: number;
    timestamps?: boolean;
    previous?: boolean;
    sinceSeconds?: string;
    enabled?: boolean;
    refetchIntervalMs?: number | false;
  }
) {
  const liveConnected = useAppStore((s) => s.liveUpdatesConnected);
  return useQuery({
    queryKey: ['logs', context, namespace, pod, container, opts?.tailLines, opts?.timestamps, opts?.previous, opts?.sinceSeconds],
    queryFn: async () => {
      const client = await getResourcesClient();
      return client.getLogs({
        context,
        namespace,
        pod,
        container,
        tailLines: opts?.tailLines ?? 500,
        timestamps: opts?.timestamps ?? false,
        previous: opts?.previous ?? false,
        sinceSeconds: opts?.sinceSeconds || '',
      });
    },
    enabled: (opts?.enabled ?? true) && !!context && !!namespace && !!pod && !!container,
    refetchInterval: opts?.refetchIntervalMs === undefined
      ? fallbackInterval(liveConnected, 5000, 5000)
      : opts.refetchIntervalMs,
    refetchOnWindowFocus: false,
  });
}

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job']);

export function useOwnedPods(context: string, namespace: string, kind: string, name: string) {
  const liveConnected = useAppStore((s) => s.liveUpdatesConnected);
  return useQuery({
    queryKey: ['ownedPods', context, namespace, kind, name],
    queryFn: async () => {
      const client = await getResourcesClient();
      return client.getOwnedPods({ context, namespace, kind, name });
    },
    enabled: !!context && !!namespace && !!kind && !!name && WORKLOAD_KINDS.has(kind),
    refetchInterval: fallbackInterval(liveConnected, 10000),
  });
}

export function useDeleteResource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; namespace: string; gvr: GVR; name: string; gracePeriod?: number }) => {
      const client = await getResourcesClient();
      return client.deleteResource({
        context: params.context,
        namespace: params.namespace,
        gvr: params.gvr,
        name: params.name,
        gracePeriodSeconds: params.gracePeriod ?? -1,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
    },
  });
}

export function useScaleResource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; namespace: string; gvr: GVR; name: string; replicas: number }) => {
      const client = await getResourcesClient();
      return client.scaleResource({
        context: params.context,
        namespace: params.namespace,
        gvr: params.gvr,
        name: params.name,
        replicas: params.replicas,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
      queryClient.invalidateQueries({ queryKey: ['resource'] });
      queryClient.invalidateQueries({ queryKey: ['resourceCounts'] });
    },
  });
}

export function useRestartResource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; namespace: string; gvr: GVR; name: string }) => {
      const client = await getResourcesClient();
      return client.restartResource({
        context: params.context,
        namespace: params.namespace,
        gvr: params.gvr,
        name: params.name,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
      queryClient.invalidateQueries({ queryKey: ['resource'] });
    },
  });
}

// --- Helm ---

export function useHelmReleases(context: string, namespace: string) {
  return useQuery({
    queryKey: ['helmReleases', context, namespace],
    queryFn: async () => {
      const client = await getHelmClient();
      return client.listReleases({ context, namespace });
    },
    enabled: !!context,
    refetchInterval: 30000,
  });
}

export function useHelmRelease(context: string, namespace: string, name: string) {
  return useQuery({
    queryKey: ['helmRelease', context, namespace, name],
    queryFn: async () => {
      const client = await getHelmClient();
      return client.getRelease({ context, namespace, name });
    },
    enabled: !!context && !!name && !!namespace,
  });
}

export function useHelmReleaseValues(context: string, namespace: string, name: string) {
  return useQuery({
    queryKey: ['helmReleaseValues', context, namespace, name],
    queryFn: async () => {
      const client = await getHelmClient();
      return client.getReleaseValues({ context, namespace, name });
    },
    enabled: !!context && !!name && !!namespace,
  });
}

export function useHelmReleaseHistory(context: string, namespace: string, name: string) {
  return useQuery({
    queryKey: ['helmReleaseHistory', context, namespace, name],
    queryFn: async () => {
      const client = await getHelmClient();
      return client.getReleaseHistory({ context, namespace, name });
    },
    enabled: !!context && !!name && !!namespace,
  });
}

export function useUninstallRelease() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; namespace: string; name: string }) => {
      const client = await getHelmClient();
      return client.uninstallRelease(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['helmReleases'] });
      queryClient.invalidateQueries({ queryKey: ['helmRelease'] });
    },
  });
}

export function useRollbackRelease() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; namespace: string; name: string; revision: number }) => {
      const client = await getHelmClient();
      return client.rollbackRelease(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['helmReleases'] });
      queryClient.invalidateQueries({ queryKey: ['helmRelease'] });
      queryClient.invalidateQueries({ queryKey: ['helmReleaseHistory'] });
    },
  });
}

export function useResourceCounts(context: string, namespace: string, gvrs: GVR[]) {
  const liveConnected = useAppStore((s) => s.liveUpdatesConnected);
  return useQuery({
    queryKey: ['resourceCounts', context, namespace, gvrs.map(g => `${g.group}/${g.version}/${g.resource}`).join(',')],
    queryFn: async () => {
      const client = await getResourcesClient();
      return client.getResourceCounts({ context, namespace, gvrs });
    },
    enabled: !!context && gvrs.length > 0,
    refetchInterval: fallbackInterval(liveConnected, 30000, 120000),
  });
}

export function useClusterOverview(context: string, namespace: string) {
  const liveConnected = useAppStore((s) => s.liveUpdatesConnected);
  return useQuery({
    queryKey: ['cluster-overview', context, namespace],
    queryFn: async () => {
      const client = await getOverviewClient();
      return client.getClusterOverview({ context, namespace });
    },
    enabled: !!context,
    refetchInterval: fallbackInterval(liveConnected, 5000),
  });
}

export function useUpgradeRelease() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; namespace: string; name: string; valuesYaml: string }) => {
      const client = await getHelmClient();
      return client.upgradeRelease(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['helmReleases'] });
      queryClient.invalidateQueries({ queryKey: ['helmRelease'] });
      queryClient.invalidateQueries({ queryKey: ['helmReleaseHistory'] });
      queryClient.invalidateQueries({ queryKey: ['helmReleaseValues'] });
    },
  });
}

export function useCordonNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; name: string }) => {
      const client = await getResourcesClient();
      return client.cordonNode(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
      queryClient.invalidateQueries({ queryKey: ['resource'] });
    },
  });
}

export function useUncordonNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; name: string }) => {
      const client = await getResourcesClient();
      return client.uncordonNode(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
      queryClient.invalidateQueries({ queryKey: ['resource'] });
    },
  });
}

export function useDrainNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; name: string; ignoreDaemonsets?: boolean }) => {
      const client = await getResourcesClient();
      return client.drainNode({ context: params.context, name: params.name, ignoreDaemonsets: params.ignoreDaemonsets ?? true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
      queryClient.invalidateQueries({ queryKey: ['resource'] });
    },
  });
}

export function useTriggerCronJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { context: string; namespace: string; name: string }) => {
      const client = await getResourcesClient();
      return client.triggerCronJob(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
      queryClient.invalidateQueries({ queryKey: ['resource'] });
    },
  });
}

// --- Metrics / Prometheus hooks ---

export interface PrometheusEndpoint {
  namespace: string;
  service: string;
  port: number;
  source: string;
  url?: string;
}

export function usePrometheusDiscover(context: string) {
  return useQuery({
    queryKey: ['prometheusDiscover', context],
    queryFn: async (): Promise<{ found: boolean; endpoint?: PrometheusEndpoint }> => {
      const r = await fetchSetupAPI(`/api/metrics/prometheus/discover?context=${encodeURIComponent(context)}`);
      if (!r.ok) throw new Error('discover failed');
      return r.json();
    },
    enabled: !!context,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

export function usePrometheusRange(
  params: {
    context: string;
    ep: PrometheusEndpoint;
    query: string;
    start: number;
    end: number;
    step: number;
  } | null,
) {
  return useQuery({
    queryKey: ['prometheusRange', params],
    queryFn: async () => {
      const p = params!;
      const qs = new URLSearchParams({
        context: p.context,
        query: p.query,
        start: String(p.start),
        end: String(p.end),
        step: String(p.step),
        ep_ns: p.ep.namespace ?? '',
        ep_svc: p.ep.service ?? '',
        ep_port: String(p.ep.port ?? 0),
        ep_url: p.ep.url ?? '',
      });
      const r = await fetchSetupAPI(`/api/metrics/prometheus/query_range?${qs}`);
      if (!r.ok) throw new Error('range query failed');
      return r.json();
    },
    enabled: !!params,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function usePrometheusInstant(
  params: { context: string; ep: PrometheusEndpoint; query: string } | null,
) {
  return useQuery({
    queryKey: ['prometheusInstant', params],
    queryFn: async () => {
      const p = params!;
      const qs = new URLSearchParams({
        context: p.context,
        query: p.query,
        ep_ns: p.ep.namespace ?? '',
        ep_svc: p.ep.service ?? '',
        ep_port: String(p.ep.port ?? 0),
        ep_url: p.ep.url ?? '',
      });
      const r = await fetchSetupAPI(`/api/metrics/prometheus/query?${qs}`);
      if (!r.ok) throw new Error('instant query failed');
      return r.json();
    },
    enabled: !!params,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useSetPrometheusURL() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (url: string) => {
      const r = await fetchSetupAPI('/api/metrics/prometheus/url', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      if (!r.ok) throw new Error('failed to set URL');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prometheusDiscover'] });
    },
  });
}

export interface NodeDebugResult {
  pod: string;
  namespace: string;
  container: string;
}

export function useDebugNode() {
  return useMutation({
    mutationFn: async (params: {
      context: string;
      node: string;
      namespace?: string;
      image?: string;
    }): Promise<NodeDebugResult> => {
      const r = await fetchSetupAPI('/api/nodes/debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: params.context,
          node: params.node,
          namespace: params.namespace ?? 'default',
          image: params.image ?? 'busybox',
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'unknown error' })) as { error?: string };
        throw new Error(err.error ?? 'failed to create debug pod');
      }
      return r.json();
    },
  });
}

export function useDeleteDebugPod() {
  return useMutation({
    mutationFn: async (params: { context: string; pod: string; namespace: string }) => {
      const qs = new URLSearchParams({ context: params.context, pod: params.pod, namespace: params.namespace });
      const r = await fetchSetupAPI(`/api/nodes/debug/delete?${qs}`, { method: 'DELETE' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'unknown error' })) as { error?: string };
        throw new Error(err.error ?? 'failed to delete debug pod');
      }
    },
  });
}
