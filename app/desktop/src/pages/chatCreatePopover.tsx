import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { DENSE_MENU_WIDTH, popoverGeometry, type ChatCreatePopoverAnchor } from './chatCreateGeometry';

const DismissContext = createContext<() => void>(() => {});
const MENU_FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The popover shares the Help menu surface (`app-dense-menu`): the action
 * list uses its dense rows, and the follow-up pickers open as a wider
 * detail view, like Help's detail pages. */
export function ChatCreatePopover({ children, onClose, anchorRect, dense, titleId, focusKey }: {
  children: ReactNode;
  onClose: () => void;
  anchorRect?: ChatCreatePopoverAnchor | null;
  dense: boolean;
  titleId: string;
  focusKey: string;
}) {
  const { style, placement } = popoverGeometry(anchorRect, dense ? DENSE_MENU_WIDTH : undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  // The control that opened the menu (usually the + button), read once on open.
  const [restoreFocusTarget] = useState(() => (
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null
  ));
  const dismissedRef = useRef(false);
  const dismiss = useCallback(() => {
    dismissedRef.current = true;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.querySelectorAll<HTMLElement>(MENU_FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
      if (!controls.length) return;
      event.preventDefault();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const destination = index < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[destination]?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Return focus to the + button only when the menu was dismissed, so a
      // started chat keeps the focus its own view sets.
      if (dismissedRef.current && restoreFocusTarget?.isConnected) restoreFocusTarget.focus();
    };
  }, [dismiss, restoreFocusTarget]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    // The action list focuses its first row; pickers focus their own field or
    // the panel, so Tab starts at the first control without a stray ring.
    const initial = panel.querySelector<HTMLElement>('[autofocus], .app-dense-menu-items > button') ?? panel;
    initial.focus();
  }, [focusKey]);

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 cursor-default bg-transparent"
        aria-label="Close create chat"
        tabIndex={-1}
        onClick={dismiss}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-create-surface="side-popover"
        data-popover-placement={placement}
        className={cn(
          'app-transient-surface app-frosted-popover app-chat-create-popover app-chat-create-popover-enter app-dense-menu fixed z-50 overflow-hidden',
          dense ? null : 'app-chat-create-detail',
        )}
        style={style}
      >
        <DismissContext.Provider value={dismiss}>{children}</DismissContext.Provider>
      </div>
    </>
  );
}

export function ChatCreateMenuHeader({ title, titleId }: { title: string; titleId: string }) {
  const dismiss = useContext(DismissContext);
  return (
    <header className="app-dense-menu-header">
      <h2 id={titleId}>{title}</h2>
      <button type="button" onClick={dismiss} className="app-chat-create-close" aria-label="Close create chat">
        <X size={16} aria-hidden="true" />
      </button>
    </header>
  );
}

export function ChatCreateHeader({ title, titleId, subtitle }: { title: string; titleId: string; subtitle?: string }) {
  const dismiss = useContext(DismissContext);
  return (
    <div className="mb-2 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 id={titleId} className="m-0 truncate text-[13px] font-semibold leading-5 text-[color:var(--utility-foreground)]">{title}</h2>
        {subtitle ? <div className="mt-px text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">{subtitle}</div> : null}
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="app-button-quiet app-chat-create-close grid h-6 w-6 shrink-0 place-items-center rounded-[6px] p-0"
        aria-label="Close create chat"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ChatCreateMenuRow({ icon: Icon, title, onClick }: { icon: LucideIcon; title: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      <Icon aria-hidden="true" />
      <span>{title}</span>
    </button>
  );
}
