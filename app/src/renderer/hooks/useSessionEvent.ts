import { useEffect, useRef } from 'react';

export type SessionEventType = 'locked' | 'unlocked' | 'profile-changed';

export function useSessionEvent(onEvent: (type: SessionEventType) => void) {
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (!api?.onSessionEvent) return;
    return api.onSessionEvent((type: string) => {
      callbackRef.current(type as SessionEventType);
    });
  }, []); // subscribe once on mount
}
