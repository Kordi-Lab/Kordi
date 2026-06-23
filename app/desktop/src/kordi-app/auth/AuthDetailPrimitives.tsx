import { useRef } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function DetailSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="app-auth-detail-section overflow-hidden rounded-[20px] bg-white/[0.035] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
      {title ? <div className="px-4 pb-1 pt-3 text-[13px] font-medium tracking-[-0.01em] text-slate-200">{title}</div> : null}
      <div>{children}</div>
    </section>
  );
}

export function DetailRow({
  title,
  meta,
  detail,
  trailing,
  multiline = false,
}: {
  title: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  multiline?: boolean;
}) {
  return (
    <div
      className={cn(
        'grid items-center gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto]',
        multiline && 'sm:items-start',
      )}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-white">{title}</div>
        {meta && <div className="mt-1 text-[11px] leading-5 text-slate-500">{meta}</div>}
        {detail && <div className="mt-1 text-[11px] leading-5 text-slate-400">{detail}</div>}
      </div>
      {trailing && <div className="relative z-10 flex flex-wrap items-center gap-1.5 pointer-events-auto sm:justify-end">{trailing}</div>}
    </div>
  );
}

export function SectionDivider() {
  return <div className="mx-4 h-px bg-white/8" />;
}

function stopEventPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export const nonDragStyle: CSSProperties = { WebkitAppRegion: 'no-drag' as const };

export const authButtonNeutralClass =
  'app-auth-button-neutral border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.065),rgba(255,255,255,0.035))] text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_rgba(0,0,0,0.16)] hover:border-white/14 hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.085),rgba(255,255,255,0.05))]';

export const authButtonPrimaryClass =
  'app-auth-button-primary border border-emerald-300/26 bg-[linear-gradient(180deg,rgba(16,185,129,0.18),rgba(5,150,105,0.14))] text-emerald-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_24px_rgba(0,0,0,0.16)] hover:border-emerald-200/36 hover:bg-[linear-gradient(180deg,rgba(16,185,129,0.24),rgba(5,150,105,0.18))]';

export const authButtonDangerClass =
  'app-auth-button-danger border border-rose-400/20 bg-[linear-gradient(180deg,rgba(244,63,94,0.16),rgba(190,24,93,0.12))] text-rose-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_24px_rgba(0,0,0,0.16)] hover:border-rose-300/28 hover:bg-[linear-gradient(180deg,rgba(244,63,94,0.22),rgba(190,24,93,0.16))]';

export const authActiveBadgeClass =
  'app-auth-badge-active inline-flex h-8.5 items-center justify-center rounded-full border border-violet-400/26 bg-[linear-gradient(180deg,rgba(139,92,246,0.22),rgba(91,33,182,0.16))] px-3.5 text-[12px] font-medium tracking-[-0.01em] text-violet-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]';

const authButtonBaseClass =
  'inline-flex h-8.5 items-center justify-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[12px] font-medium tracking-[-0.01em] transition-all duration-150 disabled:pointer-events-none disabled:opacity-50 cursor-pointer';

type AuthActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function AuthActionButton({
  className,
  style,
  onClick,
  onMouseDown,
  onMouseUp,
  onPointerDown,
  onPointerUp,
  type = 'button',
  ...props
}: AuthActionButtonProps) {
  const lastPressAtRef = useRef(0);

  const triggerPress = (
    event: ReactMouseEvent<HTMLButtonElement> | ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (props.disabled) return;
    const now = Date.now();
    if (now - lastPressAtRef.current < 250) return;
    lastPressAtRef.current = now;
    onClick?.(event as unknown as ReactMouseEvent<HTMLButtonElement>);
  };

  return (
    <button
      {...props}
      type={type}
      onClick={(event) => {
        stopEventPropagation(event);
        triggerPress(event);
      }}
      className={cn(authButtonBaseClass, className)}
      style={{ ...nonDragStyle, ...style }}
      onMouseDown={(event) => {
        stopEventPropagation(event);
        onMouseDown?.(event);
      }}
      onMouseUp={(event) => {
        stopEventPropagation(event);
        onMouseUp?.(event);
        triggerPress(event);
      }}
      onPointerDown={(event) => {
        stopEventPropagation(event);
        onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        stopEventPropagation(event);
        onPointerUp?.(event);
        triggerPress(event);
      }}
    />
  );
}
