import React, { useEffect, useRef } from 'react';

export type ContextMenuItem =
  | { separator: true; label?: never; danger?: never; disabled?: never; onClick?: never }
  | { separator?: false; label: string; danger?: boolean; disabled?: boolean; onClick?: () => void };

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // Clamp to viewport
  const menuWidth = 180;
  const approxItemHeight = 28;
  const itemCount = items.filter((i) => !i.separator).length;
  const sepCount = items.filter((i) => i.separator).length;
  const menuHeight = itemCount * approxItemHeight + sepCount * 9 + 8;

  const left = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const top = y + menuHeight > window.innerHeight ? y - menuHeight : y;

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={i} className="context-menu-separator" />;
        }
        return (
          <div
            key={i}
            className={`context-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`}
            onClick={() => {
              if (!item.disabled) {
                item.onClick?.();
                onClose();
              }
            }}
          >
            {item.label}
          </div>
        );
      })}
    </div>
  );
}
