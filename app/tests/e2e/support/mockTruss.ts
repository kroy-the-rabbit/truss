import type { Page, Route, Request } from '@playwright/test';

const DAEMON_PORT = 19091;
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`;

type Mode = 'uninitialized' | 'ready';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function parseBody(request: Request): any {
  try {
    return request.postDataJSON();
  } catch {
    return {};
  }
}

function setupStatus(mode: Mode) {
  if (mode === 'uninitialized') {
    return { initialized: false, locked: false, broken: false };
  }
  return { initialized: true, locked: false, broken: false, method: 'password' };
}

function resourceKindsResponse() {
  return {
    groups: [
      {
        category: 'Workloads',
        kinds: [
          { kind: 'Pod', group: '', version: 'v1', resource: 'pods', namespaced: true },
        ],
      },
      {
        category: 'Custom',
        kinds: [],
      },
    ],
  };
}

function podResource(name = 'demo-pod') {
  return {
    metadata: {
      name,
      namespace: 'default',
      uid: 'pod-uid-1',
      creationTimestamp: '2026-02-22T10:00:00Z',
      labels: { app: 'demo' },
      annotations: {},
    },
    kind: 'Pod',
    apiVersion: 'v1',
    summary: [
      { key: 'Phase', value: 'Running' },
      { key: 'Ready', value: '1/1' },
      { key: 'Restarts', value: '0' },
    ],
    conditions: [],
  };
}

export async function installElectronApiMock(page: Page) {
  await page.addInitScript(({ daemonPort }) => {
    const noopUnsub = () => {};
    const prefs = {
      themeMode: 'dark',
      effectiveTheme: 'dark',
      userCss: '',
      userCssPath: '',
      execPathHints: [],
    };

    (window as any).electronAPI = {
      getDaemonConfig: async () => ({ port: daemonPort, token: 'test-token' }),
      getPreferences: async () => prefs,
      onThemeUpdated: () => noopUnsub,
      getAppInfo: async () => ({ name: 'Truss', version: 'test' }),
      sessionBroadcast: async () => undefined,
      openSessionWindow: async () => ({ ok: true }),
      openPortForwardWindow: async () => ({ ok: true }),
      portForwardList: async () => [],
      portForwardStart: async () => ({ ok: true }),
      portForwardStop: async () => ({ ok: true }),
      portForwardOpenUrl: async () => ({ ok: true }),
      onAddSessionTab: () => noopUnsub,
      onMenuAction: () => noopUnsub,
      onSessionEvent: () => noopUnsub,
      setThemeMode: async () => undefined,
      setExecPathHints: async () => undefined,
      openExternalTerminal: async () => ({ ok: true }),
      localFsList: async () => [],
      localFsHome: async () => '/tmp',
      localFsSave: async () => undefined,
      localFsRead: async () => '',
      localFsMkdir: async () => undefined,
      openFileTransferWindow: async () => ({ ok: true }),
      sessionLogAppend: async () => undefined,
      sessionLogPath: async () => '',
      sessionLogSaveAs: async () => undefined,
      clipboardWriteText: async () => undefined,
      clipboardReadText: async () => '',
      yamlOpenExternalEditor: async () => ({ filePath: '' }),
      yamlReadExternalEditorFile: async () => '',
      yamlCleanupExternalEditorFile: async () => undefined,
      openYamlDiffWindow: async () => ({ approved: false }),
      getYamlDiffPayload: async () => null,
      submitYamlDiffDecision: async () => undefined,
      pluginList: async () => [],
      pluginReadFile: async () => '',
      pluginStorageGet: async () => null,
      pluginStorageSet: async () => undefined,
      pluginStorageDelete: async () => undefined,
      pluginSetEnabled: async () => undefined,
      openPluginDirectory: async () => undefined,
    };
  }, { daemonPort: DAEMON_PORT });
}

export async function installBackendMocks(page: Page, mode: Mode) {
  await page.route(`${DAEMON_BASE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/setup-status') {
      return json(route, setupStatus(mode));
    }
    if (path === '/api/setup/preferences') {
      return json(route, {
        auto_lock_minutes: 20,
        startup_confirmation_required: false,
        never_confirm_startup_bypass: false,
      });
    }
    if (path === '/api/profiles') {
      return json(route, {
        profiles: [{ name: 'default' }],
        active_profile: 'default',
        active_profile_color: '',
      });
    }
    if (path === '/api/context-preflight') {
      return json(route, {
        context: 'dev-cluster',
        has_exec_auth: true,
        missing_exec_helper: false,
      });
    }

    if (mode === 'ready' && path === '/truss.v1.HealthService/Ping') {
      return json(route, { status: 'ok', version: 'test' });
    }
    if (mode === 'ready' && path === '/truss.v1.ContextsService/ListContexts') {
      return json(route, {
        contexts: [
          { name: 'dev-cluster', cluster: 'dev', user: 'dev', isActive: true },
        ],
      });
    }
    if (mode === 'ready' && path === '/truss.v1.ContextsService/ListNamespaces') {
      return json(route, {
        namespaces: [
          { name: 'default', status: 'Active' },
          { name: 'kube-system', status: 'Active' },
        ],
      });
    }
    if (mode === 'ready' && path === '/truss.v1.DiscoveryService/ListResourceKinds') {
      return json(route, resourceKindsResponse());
    }
    if (mode === 'ready' && path === '/truss.v1.ResourcesService/GetResourceCounts') {
      const body = parseBody(request);
      const counts = Array.isArray(body?.gvrs)
        ? body.gvrs.map((gvr: any) => ({
            gvr,
            count: gvr?.resource === 'pods' ? 1 : 0,
          }))
        : [];
      return json(route, { counts });
    }
    if (mode === 'ready' && path === '/truss.v1.OverviewService/GetClusterOverview') {
      return json(route, {
        nodes: { total: 1, ready: 1, notReady: 0, metrics: [] },
        pods: { running: 1, pending: 0, failed: 0, succeeded: 0, unknown: 0 },
        deployments: { total: 0, ready: 0, notReady: 0, updating: 0 },
        statefulSets: { total: 0, ready: 0, notReady: 0, updating: 0 },
        daemonSets: { total: 0, ready: 0, notReady: 0, updating: 0 },
        recentWarnings: [],
        cacheWarm: true,
        metricsAvailable: false,
        topCpuPods: [],
        topMemPods: [],
      });
    }
    if (mode === 'ready' && path === '/truss.v1.ResourcesService/ListResources') {
      const body = parseBody(request);
      const isPods = body?.gvr?.resource === 'pods';
      return json(route, {
        resources: isPods ? [podResource()] : [],
        nextPageToken: '',
        totalCount: isPods ? 1 : 0,
      });
    }
    if (mode === 'ready' && path === '/truss.v1.ResourcesService/GetResource') {
      return json(route, { resource: podResource() });
    }
    if (mode === 'ready' && path === '/truss.v1.ResourcesService/GetPodInfo') {
      return json(route, {
        podPhase: 'Running',
        podIp: '10.0.0.5',
        nodeName: 'node-1',
        qosClass: 'BestEffort',
        containers: [
          {
            name: 'app',
            state: 'running',
            reason: '',
            ready: true,
            restartCount: 0,
            isInit: false,
            image: 'nginx:1.27',
            startedAt: '2026-02-22T10:00:05Z',
            finishedAt: '',
            message: '',
          },
        ],
      });
    }
    if (mode === 'ready' && path === '/truss.v1.YamlService/GetYaml') {
      return json(route, {
        yaml: [
          'apiVersion: v1',
          'kind: Pod',
          'metadata:',
          '  name: demo-pod',
          '  namespace: default',
          'spec: {}',
          '',
        ].join('\n'),
      });
    }

    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unhandled mock route: ${path}` }),
    });
  });
}
