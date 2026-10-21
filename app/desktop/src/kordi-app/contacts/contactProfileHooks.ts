import { useEffect, useRef, useState } from 'react';

/** Copies a value and reports `copied` for 1.5 seconds. */
export function useCopyValue(value: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => { void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined); };
  return { copied, copy };
}

/** Open state for a popover that closes on an outside pointer or Escape. */
export function usePopover(className = 'app-contacts-tile-slot relative') {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);
  const slotProps = {
    ref: rootRef,
    className,
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        setOpen(false);
      }
    },
  };
  return { open, setOpen, slotProps };
}
