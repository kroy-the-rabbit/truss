import React from 'react';
import { beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Breadcrumb } from '../../src/renderer/components/Breadcrumb';
import { useAppStore } from '../../src/renderer/state/store';
import { resetAppStore } from './storeTestUtils';

function gvr(resource: string, group = '', version = 'v1') {
  return { group, version, resource } as any;
}

describe('Breadcrumb', () => {
  beforeEach(() => {
    resetAppStore();
  });

  test('renders nothing without an active context', () => {
    const { container } = render(<Breadcrumb />);
    expect(container).toBeEmptyDOMElement();
  });

  test('renders path and supports navigation clicks', () => {
    const s = useAppStore.getState();
    s.setActiveContext('dev-cluster');
    s.setActiveNamespace('default');
    s.setSelectedKind(gvr('pods'), 'Pod');
    s.setSelectedResource('demo-pod', 'default');

    render(<Breadcrumb />);

    expect(screen.getByText('dev-cluster')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.getByText('Pod')).toBeInTheDocument();
    expect(screen.getByText('demo-pod')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Pod'));
    expect(useAppStore.getState().selectedResource).toBe('');

    fireEvent.click(screen.getByText('default'));
    expect(useAppStore.getState().selectedKind).toBeNull();
    expect(useAppStore.getState().selectedKindLabel).toBe('');
  });
});
