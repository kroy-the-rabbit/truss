import { RefObject, useEffect } from 'react';

type Options = {
  active?: boolean;
  initialFocusSelector?: string;
};

const TABBABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function isVisible(el: HTMLElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function getTabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter((el) => isVisible(el));
}

export function useModalFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options?: Options,
) {
  const active = options?.active ?? true;
  const initialFocusSelector = options?.initialFocusSelector;

  useEffect(() => {
    if (!active) return;
    const root = containerRef.current;
    if (!root) return;

    const prevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let raf = 0;

    const focusInitial = () => {
      const target = initialFocusSelector
        ? root.querySelector<HTMLElement>(initialFocusSelector)
        : null;
      const fallback = getTabbables(root)[0] || root;
      const focusTarget = (target && !target.hasAttribute('disabled') && isVisible(target)) ? target : fallback;
      focusTarget.focus();
    };

    raf = window.requestAnimationFrame(focusInitial);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const tabbables = getTabbables(root);
      if (tabbables.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }

      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const current = document.activeElement as HTMLElement | null;
      const inside = current ? root.contains(current) : false;

      if (e.shiftKey) {
        if (!inside || current === first) {
          e.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || current === last) {
        e.preventDefault();
        first.focus();
      }
    };

    root.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(raf);
      root.removeEventListener('keydown', onKeyDown);
      if (prevActive && prevActive.isConnected) {
        prevActive.focus();
      }
    };
  }, [active, containerRef, initialFocusSelector]);
}
