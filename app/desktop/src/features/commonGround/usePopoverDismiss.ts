import { useEffect, type RefObject } from 'react';

/** Closes a popover on Escape or a click outside it and outside its anchor (`[anchor]`). */
export function usePopoverDismiss(ref: RefObject<HTMLElement | null>, anchor: string, onClose: () => void) {
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !ref.current?.contains(target) && !(target instanceof Element && target.closest(anchor))) onClose();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [ref, anchor, onClose]);
}
