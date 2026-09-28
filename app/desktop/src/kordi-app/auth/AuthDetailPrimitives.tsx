import { useRef } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { SettingsRow } from '@/kordi-app/components/settingsLayout';

// Auth pages use the shared settings row so they read like every other settings page.
export function DetailRow({
  title,
  meta,
  detail,
  trailing,
}: {
  title: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <SettingsRow
      title={title}
      description={meta || detail ? <>{detail}{meta ? <span className="block text-[11px] text-slate-500">{meta}</span> : null}</> : undefined}
      control={trailing}
    />
  );
}

/** Muted page notice, for example when the backend has no OMP yet. */
export function AuthPageNotice({ children }: { children: ReactNode }) {
  return <p role="note" data-auth-page-notice="" className="m-0 pb-3 text-[12px] leading-5 text-slate-400">{children}</p>;
}

function stopEventPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export const nonDragStyle: CSSProperties = { WebkitAppRegion: 'no-drag' as const };

export const authButtonNeutralClass =
  'app-auth-button-neutral border border-white/10 bg-white/[0.06] text-slate-100 hover:border-white/16 hover:bg-white/[0.1]';

export const authButtonPrimaryClass =
  'app-auth-button-primary border border-emerald-300/26 bg-emerald-400/[0.14] text-emerald-50 hover:border-emerald-200/36 hover:bg-emerald-400/[0.2]';

export const authButtonDangerClass =
  'app-auth-button-danger border border-rose-400/20 bg-rose-500/[0.12] text-rose-50 hover:border-rose-300/28 hover:bg-rose-500/[0.18]';

export const authActiveBadgeClass =
  'app-auth-badge-active inline-flex h-7 items-center justify-center rounded-full border border-violet-400/26 bg-violet-500/[0.15] px-2.5 text-[11px] font-medium text-violet-50';

const authButtonBaseClass =
  'inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-[12px] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 cursor-pointer';

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
