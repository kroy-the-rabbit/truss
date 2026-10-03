import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { makeHealthErrorHandler, shouldRetryQuery } from '../../src/renderer/state/queryClient';
import { describeQueryError, isRbacDeniedError } from '../../src/renderer/lib/connectErrors';

describe('shouldRetryQuery', () => {
  test('never retries Unauthenticated or PermissionDenied', () => {
    expect(shouldRetryQuery(0, new ConnectError('exec plugin failed', Code.Unauthenticated))).toBe(false);
    expect(shouldRetryQuery(0, new ConnectError('forbidden', Code.PermissionDenied))).toBe(false);
  });

  test('retries other failures up to twice', () => {
    const err = new ConnectError('connection refused', Code.Unavailable);
    expect(shouldRetryQuery(0, err)).toBe(true);
    expect(shouldRetryQuery(1, err)).toBe(true);
    expect(shouldRetryQuery(2, err)).toBe(false);
    expect(shouldRetryQuery(0, new Error('plain'))).toBe(true);
    expect(shouldRetryQuery(2, new Error('plain'))).toBe(false);
  });
});

describe('isRbacDeniedError', () => {
  test('PermissionDenied is RBAC unless it is a read-only mode denial', () => {
    expect(isRbacDeniedError(new ConnectError('pods is forbidden', Code.PermissionDenied))).toBe(true);
    expect(isRbacDeniedError(new ConnectError('read-only mode is enabled', Code.PermissionDenied))).toBe(false);
  });

  test('auth and connectivity codes are not RBAC even if the text says forbidden', () => {
    expect(isRbacDeniedError(new ConnectError('forbidden: token expired', Code.Unauthenticated))).toBe(false);
    expect(isRbacDeniedError(new ConnectError('forbidden', Code.Unavailable))).toBe(false);
  });

  test('falls back to string matching for uncoded errors', () => {
    expect(isRbacDeniedError(new Error('User "x" cannot list pods: forbidden'))).toBe(true);
    expect(isRbacDeniedError(new ConnectError('rbac: access denied', Code.Internal))).toBe(true);
    expect(isRbacDeniedError(new Error('timeout'))).toBe(false);
  });
});

describe('describeQueryError', () => {
  test('hides the raw [internal] prefix and explains auth errors', () => {
    expect(describeQueryError(new ConnectError('boom', Code.Internal))).toBe('boom');
    expect(describeQueryError(new ConnectError('exit code 1', Code.Unauthenticated))).toMatch(/Sign-in required/);
  });
});

describe('makeHealthErrorHandler', () => {
  function fakeQuery(queryKey: unknown[]) {
    return { queryKey } as any;
  }

  test('invalidates the failing context health on Unauthenticated/Unavailable, throttled', () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const handler = makeHealthErrorHandler(() => client);

    handler(new ConnectError('x', Code.Unauthenticated), fakeQuery(['resources', 'ctx-a', 'default']));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['contextHealth', 'ctx-a'] }, { cancelRefetch: false });

    handler(new ConnectError('x', Code.Unavailable), fakeQuery(['namespaces', 'ctx-a']));
    expect(spy).toHaveBeenCalledTimes(1);

    handler(new ConnectError('x', Code.Unavailable), fakeQuery(['namespaces', 'ctx-b']));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['contextHealth', 'ctx-b'] }, { cancelRefetch: false });
  });

  test('ignores other codes and the health query itself', () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const handler = makeHealthErrorHandler(() => client);
    handler(new ConnectError('x', Code.PermissionDenied), fakeQuery(['resources', 'ctx-a']));
    handler(new Error('plain'), fakeQuery(['resources', 'ctx-a']));
    handler(new ConnectError('x', Code.Unauthenticated), fakeQuery(['contextHealth', 'ctx-a']));
    expect(spy).not.toHaveBeenCalled();
  });
});
