// Small accessible building blocks for AI access settings, "About this
// reply", and the PiP switch: a labeled switch and a modal dialog that traps
// focus and returns it to whatever opened it.
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AgentTrustSwitch({ checked, label, describedBy, disabled, onChange }: {
  checked: boolean;
  label: string;
  describedBy?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'app-settings-switch relative h-6 w-10 shrink-0 rounded-full border outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[var(--app-quiet-control-focus-ring)] focus-visible:ring-offset-2 disabled:opacity-50',
        checked
          ? 'border-[color:var(--app-sidebar-accent)] bg-[color:var(--app-sidebar-accent)]'
          : 'border-[color:var(--app-control-border)] bg-[color:var(--app-control-bg)] hover:bg-[color:var(--app-control-hover)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        )}
      />
    </button>
  );
}

/** A labeled switch row with help text the switch points at. */
export function AgentTrustSwitchRow({ label, help, footnote, checked, disabled, onChange }: {
  label: string;
  help: ReactNode;
  footnote?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const helpId = useId();
  return (
    <div className="app-ai-access-row flex items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium leading-5">{label}</div>
        <div id={helpId} className="mt-0.5 text-[11px] leading-[1.45] text-[color:var(--utility-muted-text)]">
          {help}
          {footnote ? <span className="mt-1 block">{footnote}</span> : null}
        </div>
      </div>
      <AgentTrustSwitch checked={checked} label={label} describedBy={helpId} disabled={disabled} onChange={onChange} />
    </div>
  );
}

export function AgentTrustDialog({ title, children, actions, onClose, dataAttribute }: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  dataAttribute?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="app-transient-overlay fixed inset-0 z-[300] grid place-items-center px-4" data-agent-trust-dialog={dataAttribute}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="app-transient-surface w-full max-w-[28rem] rounded-[18px] border px-6 py-5"
      >
        <h2 id={titleId} className="text-[15px] font-medium leading-6">{title}</h2>
        <div className="mt-3 text-[13px] leading-5">{children}</div>
        <div className="mt-6 flex flex-wrap justify-end gap-2 text-[14px] font-semibold">{actions}</div>
      </div>
    </div>
  );
}

export function AgentTrustDialogButton({ children, primary, onClick, label }: {
  children: ReactNode;
  primary?: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'min-h-9 rounded-[10px] px-3 py-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--app-sidebar-accent)]',
        primary ? 'app-transient-row app-transient-row-selected transition' : 'app-button-quiet app-transient-flat-action',
      )}
    >
      {children}
    </button>
  );
}
