import React, { useRef } from 'react';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap';

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  labelledBy?: string;
  ariaLabel?: string;
  overlayClassName?: string;
  contentClassName?: string;
  initialFocusSelector?: string;
  closeOnOverlayClick?: boolean;
}

export function Modal({
  onClose,
  children,
  labelledBy,
  ariaLabel,
  overlayClassName = 'modal-overlay',
  contentClassName = 'modal-content',
  initialFocusSelector,
  closeOnOverlayClick = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef, { initialFocusSelector });

  return (
    <div
      className={overlayClassName}
      onClick={(e) => {
        if (!closeOnOverlayClick) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={contentClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
