import { describe, expect, beforeEach, test } from 'vitest';
import { useAppStore } from '../../src/renderer/state/store';
import { resetAppStore } from './storeTestUtils';

function gvr(resource: string, group = '', version = 'v1') {
  return { group, version, resource } as any;
}

describe('useAppStore navigation cache', () => {
  beforeEach(() => {
    resetAppStore();
  });

  test('restores per-context navigation when switching contexts', () => {
    const pods = gvr('pods');
    const services = gvr('services');

    const s = useAppStore.getState();
    s.setActiveContext('ctx-a');
    s.setActiveNamespace('team-a');
    s.setSelectedKind(pods, 'Pod');
    s.setSelectedResource('api-0', 'team-a');

    s.setActiveContext('ctx-b');
    useAppStore.getState().setActiveNamespace('team-b');
    useAppStore.getState().setSelectedKind(services, 'Service');
    useAppStore.getState().setSelectedResource('web-svc', 'team-b');

    useAppStore.getState().setActiveContext('ctx-a');
    const restored = useAppStore.getState();

    expect(restored.activeContext).toBe('ctx-a');
    expect(restored.activeNamespace).toBe('team-a');
    expect(restored.selectedKindLabel).toBe('Pod');
    expect(restored.selectedKind?.resource).toBe('pods');
    expect(restored.selectedResource).toBe('api-0');
    expect(restored.selectedResourceNamespace).toBe('team-a');
  });

  test('restores per-namespace selection inside the same context', () => {
    const pods = gvr('pods');
    const configMaps = gvr('configmaps');

    const s = useAppStore.getState();
    s.setActiveContext('ctx-a');
    s.setActiveNamespace('alpha');
    s.setSelectedKind(pods, 'Pod');
    s.setSelectedResource('alpha-pod', 'alpha');

    s.setActiveNamespace('beta');
    useAppStore.getState().setSelectedKind(configMaps, 'ConfigMap');
    useAppStore.getState().setSelectedResource('beta-config', 'beta');

    useAppStore.getState().setActiveNamespace('alpha');
    const restored = useAppStore.getState();

    expect(restored.activeNamespace).toBe('alpha');
    expect(restored.selectedKindLabel).toBe('Pod');
    expect(restored.selectedKind?.resource).toBe('pods');
    expect(restored.selectedResource).toBe('alpha-pod');
    expect(restored.selectedResourceNamespace).toBe('alpha');
  });
});
