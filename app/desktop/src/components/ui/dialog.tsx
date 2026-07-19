import {
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export type AppDialogAnchor = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type AppDialogPresentation = 'modal' | 'popover';
type AppDialogPopoverPlacement = 'right' | 'left' | 'floating';
type AppDialogPopoverStyle = CSSProperties & {
  '--app-create-enter-x'?: string;
  '--app-popover-origin'?: string;
};

function dialogPopoverGeometry(anchorRect?: AppDialogAnchor | null) {
  const width = 284;
  const gap = 10;
  const margin = 10;

  if (!anchorRect) {
    return {
      placement: 'floating' as const,
      arrowStyle: { top: 18 } satisfies CSSProperties,
      style: {
        left: 92,
        top: 74,
        '--app-create-enter-x': '-6px',
        '--app-popover-origin': 'left 22px',
      } satisfies AppDialogPopoverStyle,
    };
  }

  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const rightLeft = anchorRect.left + anchorRect.width + gap;
  const leftLeft = anchorRect.left - width - gap;
  const canFitRight = rightLeft + width <= viewportWidth - margin;
  const canFitLeft = leftLeft >= margin;
  const placement: AppDialogPopoverPlacement = canFitRight || !canFitLeft ? 'right' : 'left';
  const unclampedLeft = placement === 'right' ? rightLeft : leftLeft;
  const left = Math.min(Math.max(margin, unclampedLeft), Math.max(margin, viewportWidth - width - margin));
  const top = Math.min(Math.max(margin, anchorRect.top - 4), Math.max(margin, viewportHeight - 160));
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;
  const arrowTop = Math.min(Math.max(18, anchorCenterY - top - 6), 54);

  return {
    placement,
    arrowStyle: { top: arrowTop } satisfies CSSProperties,
    style: {
      left,
      top,
      '--app-create-enter-x': placement === 'right' ? '-8px' : '8px',
      '--app-popover-origin': placement === 'right' ? 'left 22px' : 'right 22px',
    } satisfies AppDialogPopoverStyle,
  };
}

type AppDialogProps = {
  children: ReactNode;
  titleId: string;
  descriptionId?: string;
  onDismiss: () => void;
  dismissDisabled?: boolean;
  busy?: boolean;
  presentation?: AppDialogPresentation;
  anchorRect?: AppDialogAnchor | null;
  className?: string;
  backdropClassName?: string;
};

export function AppDialog({
  children,
  titleId,
  descriptionId,
  onDismiss,
  dismissDisabled = false,
  busy = false,
  presentation = 'modal',
  anchorRect = null,
  className,
  backdropClassName,
}: AppDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onDismissRef = useRef(onDismiss);
  const dismissDisabledRef = useRef(dismissDisabled);
  const previousFocusRef = useRef<HTMLElement | null | undefined>(undefined);

  onDismissRef.current = onDismiss;
  dismissDisabledRef.current = dismissDisabled;
  if (previousFocusRef.current === undefined) {
    previousFocusRef.current = typeof document !== 'undefined'
      && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;

    if (!panel.contains(document.activeElement)) {
      const initialFocus = panel.querySelector<HTMLElement>('[autofocus]')
        ?? panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        ?? panel;
      initialFocus.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (dismissDisabledRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onDismissRef.current();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'));

      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, []);

  const isPopover = presentation === 'popover';
  const popoverGeometry = isPopover ? dialogPopoverGeometry(anchorRect) : null;

  return (
    <div
      className={cn(
        isPopover
          ? 'fixed inset-0 z-40 bg-transparent'
          : 'app-overlay fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[8px]',
        backdropClassName,
      )}
      data-dialog-presentation={presentation}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !dismissDisabled) onDismiss();
      }}
    >
      <div
        ref={panelRef}
        className={cn(
          isPopover
            ? 'app-frosted-popover app-dialog-popover app-dialog-popover-enter fixed z-50 w-[min(17.75rem,calc(100vw-1.25rem))] overflow-visible rounded-[18px] p-2.5 backdrop-blur-2xl backdrop-saturate-150'
            : 'app-modal-panel w-full max-w-md rounded-[28px] border border-[color:var(--app-divider)] p-5 text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)]',
          className,
        )}
        style={popoverGeometry?.style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        {popoverGeometry && popoverGeometry.placement !== 'floating' ? (
          <div
            aria-hidden="true"
            className={cn(
              'app-dialog-popover-arrow absolute h-3.5 w-3.5 rotate-45',
              popoverGeometry.placement === 'right' ? '-left-[0.45rem]' : '-right-[0.45rem]',
            )}
            style={popoverGeometry.arrowStyle}
          />
        ) : null}
        <div className={isPopover ? 'relative' : undefined}>{children}</div>
      </div>
    </div>
  );
}

export function AppDialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('m-0 text-[16px] font-semibold leading-6', className)}
      {...props}
    />
  );
}

export function AppDialogDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn('mt-2 mb-0 text-[13px] leading-6 text-[color:var(--utility-muted-text)]', className)}
      {...props}
    />
  );
}

export function AppDialogActions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-5 flex justify-end gap-3', className)}
      {...props}
    />
  );
}
