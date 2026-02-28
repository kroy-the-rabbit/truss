import { create } from 'zustand';

export type ToastType = 'error' | 'warning' | 'success' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number) => string;
  dismissToast: (id: string) => void;
}

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  error: 8000,
  warning: 5000,
  success: 3000,
  info: 4000,
};

const MAX_TOASTS = 4;

export const useToast = create<ToastStore>((set, get) => ({
  toasts: [],

  addToast: (type, message, duration) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set((state) => {
      const next = [...state.toasts, { id, type, message }];
      return { toasts: next.slice(-MAX_TOASTS) };
    });
    const timeout = duration ?? DEFAULT_DURATIONS[type];
    if (timeout > 0) {
      window.setTimeout(() => {
        get().dismissToast(id);
      }, timeout);
    }
    return id;
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));
