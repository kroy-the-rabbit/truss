import { describe, expect, test, vi } from 'vitest';
import { invalidateHelmViews, invalidateResourceViews } from '../../src/renderer/state/queries';

function capturePredicate(run: (client: any) => void) {
  const invalidateQueries = vi.fn();
  run({ invalidateQueries });
  expect(invalidateQueries).toHaveBeenCalledTimes(1);
  const [{ predicate }] = invalidateQueries.mock.calls[0];
  expect(typeof predicate).toBe('function');
  return predicate as (query: { queryKey: readonly unknown[] }) => boolean;
}

describe('query invalidation helpers', () => {
  test('resource invalidation refreshes all read models for a context namespace', () => {
    const predicate = capturePredicate((client) => {
      invalidateResourceViews(client, { context: 'ctx-a', namespace: 'alpha' });
    });

    expect(predicate({ queryKey: ['resources', 'ctx-a', 'alpha', '', 'v1', 'pods'] })).toBe(true);
    expect(predicate({ queryKey: ['resource', 'ctx-a', 'alpha', '', 'v1', 'pods', 'api-0'] })).toBe(true);
    expect(predicate({ queryKey: ['yaml', 'ctx-a', 'alpha', '', 'v1', 'pods', 'api-0'] })).toBe(true);
    expect(predicate({ queryKey: ['cluster-overview', 'ctx-a', 'alpha'] })).toBe(true);
    expect(predicate({ queryKey: ['events', 'ctx-a', 'alpha', 'Pod', 'api-0'] })).toBe(true);
    expect(predicate({ queryKey: ['namespaces', 'ctx-a'] })).toBe(true);

    expect(predicate({ queryKey: ['resources', 'ctx-a', 'beta', '', 'v1', 'pods'] })).toBe(false);
    expect(predicate({ queryKey: ['resources', 'ctx-b', 'alpha', '', 'v1', 'pods'] })).toBe(false);
    expect(predicate({ queryKey: ['helmRelease', 'ctx-a', 'alpha', 'api'] })).toBe(false);
  });

  test('helm invalidation is scoped to helm query roots and namespace', () => {
    const predicate = capturePredicate((client) => {
      invalidateHelmViews(client, { context: 'ctx-a', namespace: 'alpha' });
    });

    expect(predicate({ queryKey: ['helmReleases', 'ctx-a', 'alpha'] })).toBe(true);
    expect(predicate({ queryKey: ['helmRelease', 'ctx-a', 'alpha', 'api'] })).toBe(true);
    expect(predicate({ queryKey: ['helmReleaseValues', 'ctx-a', 'alpha', 'api'] })).toBe(true);
    expect(predicate({ queryKey: ['helmReleaseHistory', 'ctx-a', 'alpha', 'api'] })).toBe(true);

    expect(predicate({ queryKey: ['helmRelease', 'ctx-a', 'beta', 'api'] })).toBe(false);
    expect(predicate({ queryKey: ['helmRelease', 'ctx-b', 'alpha', 'api'] })).toBe(false);
    expect(predicate({ queryKey: ['resources', 'ctx-a', 'alpha', '', 'v1', 'pods'] })).toBe(false);
  });
});
