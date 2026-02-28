import { useAppStore } from '@/renderer/state/store';

const initialState = useAppStore.getState();

export function resetAppStore() {
  useAppStore.setState({
    ...initialState,
    contextNavCache: new Map(),
    namespaceNavCache: new Map(),
  });
}
