import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { DesktopChatEnvironmentSummary } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

type EnvironmentPopoverPlacement = 'right-start' | 'bottom-start';

type EnvironmentPopoverTriggerProps = {
  environment?: DesktopChatEnvironmentSummary | null;
  placement?: EnvironmentPopoverPlacement;
  className?: string;
  children: ReactNode;
};

function environmentKindLabel(environment?: DesktopChatEnvironmentSummary | null) {
  if (!environment) return 'unknown';
  return environment.kind.trim() || 'unknown';
}

function buildEnvironmentSummary(environment: DesktopChatEnvironmentSummary) {
  return [
    `Full root: ${environment.workspaceRoot}`,
    `Environment kind: ${environmentKindLabel(environment)}`,
    `Session scope key: ${environment.sessionScopeKey}`,
    `Remote workspace: ${environment.remote ? 'Yes' : 'No'}`,
    `Read-only safe mode: ${environment.readOnlySafeMode ? 'Yes' : 'No'}`,
  ].join('\n');
}

function resolvePopoverPosition(
  triggerRect: DOMRect,
  placement: EnvironmentPopoverPlacement,
) {
  const width = Math.min(352, window.innerWidth - 32);
  const estimatedHeight = 256;

  if (placement === 'bottom-start') {
    return {
      left: Math.max(16, Math.min(window.innerWidth - width - 16, triggerRect.left)),
      top: Math.max(16, Math.min(window.innerHeight - estimatedHeight - 16, triggerRect.bottom + 12)),
    };
  }

  return {
    left: Math.max(16, Math.min(window.innerWidth - width - 16, triggerRect.right + 12)),
    top: Math.max(16, Math.min(window.innerHeight - estimatedHeight - 16, triggerRect.top)),
  };
}

export function EnvironmentPopoverTrigger({
  environment,
  placement = 'right-start',
  className,
  children,
}: EnvironmentPopoverTriggerProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [copiedField, setCopiedField] = useState<'path' | 'scope' | 'summary' | null>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    function handleWindowChange() {
      setOpen(false);
    }

    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (!environment) {
      setOpen(false);
      setPosition(null);
    }
  }, [environment]);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  if (!environment) {
    return children;
  }

  async function handleCopy(field: 'path' | 'scope' | 'summary', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedField(null);
        copyResetTimerRef.current = null;
      }, 1200);
    } catch {
      setCopiedField(null);
    }
  }

  function togglePopover() {
    if (open) {
      setOpen(false);
      return;
    }

    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    setPosition(resolvePopoverPosition(rect, placement));
    setOpen(true);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={togglePopover}
        aria-label="Open environment details"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn('appearance-none border-0 bg-transparent p-0 text-left', className)}
      >
        {children}
      </button>
      {open && position ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Environment details"
          className="app-composer-popover fixed z-[80] w-[min(22rem,calc(100vw-2rem))] rounded-[18px] p-3 text-left"
          style={position}
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="app-composer-popover-title text-[13px] font-semibold text-white">Environment</div>
              <div className="mt-0.5 text-[11px] text-slate-400">Runtime workspace details for this desktop session.</div>
            </div>
            <Badge
              variant={environment.remote ? 'secondary' : 'outline'}
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] leading-none',
                environment.remote
                  ? 'app-badge-owned border-0'
                  : 'app-badge-neutral border-white/15 text-slate-200',
              )}
            >
              {environment.label}
            </Badge>
          </div>

          <div className="mt-3 space-y-3 text-[11px] text-slate-300">
            <div>
              <div className="app-composer-popover-section-label text-[10px] uppercase tracking-[0.14em]">Full root</div>
              <div className="mt-1 break-all text-slate-100">{environment.workspaceRoot}</div>
            </div>
            <div>
              <div className="app-composer-popover-section-label text-[10px] uppercase tracking-[0.14em]">Environment kind</div>
              <div className="mt-1 text-slate-100">{environmentKindLabel(environment)}</div>
            </div>
            <div>
              <div className="app-composer-popover-section-label text-[10px] uppercase tracking-[0.14em]">Session scope key</div>
              <div className="mt-1 break-all text-slate-100">{environment.sessionScopeKey}</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-[14px] border border-white/10 bg-white/[0.035] px-3 py-2">
                <div className="app-composer-popover-section-label text-[10px] uppercase tracking-[0.14em]">Remote workspace</div>
                <div className="mt-1 text-[12px] font-medium text-slate-100">{environment.remote ? 'Yes' : 'No'}</div>
              </div>
              <div className="rounded-[14px] border border-white/10 bg-white/[0.035] px-3 py-2">
                <div className="app-composer-popover-section-label text-[10px] uppercase tracking-[0.14em]">Read-only safe mode</div>
                <div className="mt-1 text-[12px] font-medium text-slate-100">{environment.readOnlySafeMode ? 'Yes' : 'No'}</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
              <button
                type="button"
                onClick={() => {
                  void handleCopy('path', environment.workspaceRoot);
                }}
                className="app-composer-popover-item inline-flex items-center gap-1.5 rounded-[12px] border border-white/10 bg-white/[0.035] px-3 py-2 text-[11px] font-medium text-slate-100"
              >
                {copiedField === 'path' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedField === 'path' ? 'Copied path' : 'Copy path'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleCopy('scope', environment.sessionScopeKey);
                }}
                className="app-composer-popover-item inline-flex items-center gap-1.5 rounded-[12px] border border-white/10 bg-white/[0.035] px-3 py-2 text-[11px] font-medium text-slate-100"
              >
                {copiedField === 'scope' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedField === 'scope' ? 'Copied scope key' : 'Copy scope key'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleCopy('summary', buildEnvironmentSummary(environment));
                }}
                className="app-composer-popover-item inline-flex items-center gap-1.5 rounded-[12px] border border-white/10 bg-white/[0.035] px-3 py-2 text-[11px] font-medium text-slate-100"
              >
                {copiedField === 'summary' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedField === 'summary' ? 'Copied summary' : 'Copy environment summary'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
