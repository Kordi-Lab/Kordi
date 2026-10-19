import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useSessionPanelSlot } from './sessionPanelSlot';

/** Renders `children` in the sidebar session panel when it hosts a page's list, else in place. */
export function SessionPanelPortal({ children }: { children: ReactNode }) {
  const target = useSessionPanelSlot();
  return target ? createPortal(children, target) : children;
}
