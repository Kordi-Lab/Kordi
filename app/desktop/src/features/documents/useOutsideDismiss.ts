import { useEffect, type RefObject } from 'react';

/** Closes a popover on a pointer press outside it or on Escape. */
export function useOutsideDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      // A confirmation dialog opened from the popover is portaled to the body; it is not outside.
      const inDialog = target instanceof Element && target.closest('[data-app-dialog-backdrop]');
      if (ref.current && target && !ref.current.contains(target) && !inDialog) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[data-app-dialog-backdrop]')) onDismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onDismiss, open, ref]);
}
