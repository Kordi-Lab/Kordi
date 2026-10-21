import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, BellOff, Check, Copy, MoreHorizontal, Settings, Share } from 'lucide-react';

import { cn } from '@/lib/utils';
import { DetailTile } from './ContactDetailParts';

/** Open state for a tile popover that closes on an outside pointer or Escape. */
function usePopover() {
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
    className: 'app-contacts-tile-slot relative',
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        setOpen(false);
      }
    },
  };
  return { open, setOpen, slotProps };
}

export type TileMenuItem =
  | { kind: 'item'; key: string; label: string; icon: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }
  | { kind: 'separator'; key: string };

/** "More" tile with an overflow menu. Items without a handler render disabled. */
export function MenuTile({ items }: { items: TileMenuItem[] }) {
  const { open, setOpen, slotProps } = usePopover();
  return (
    <div {...slotProps}>
      <DetailTile
        icon={<MoreHorizontal className="h-5 w-5" aria-hidden="true" />}
        label="More"
        ariaLabel="More actions"
        ariaHasPopup="menu"
        ariaExpanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      {open ? (
        <div role="menu" className="app-contacts-menu absolute right-0 top-[68px] z-10 min-w-[176px] rounded-[10px] p-1">
          {items.map((item) => item.kind === 'separator' ? (
            <div key={item.key} role="separator" className="app-contacts-menu-separator mx-1.5 my-1 h-px" />
          ) : (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled || !item.onSelect}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px] disabled:pointer-events-none',
                item.danger ? 'app-contacts-danger-action' : 'app-contacts-menu-item',
              )}
              onClick={() => {
                setOpen(false);
                item.onSelect?.();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MuteTile({ muted, onToggle }: { muted: boolean | null; onToggle?: () => void }) {
  const unavailable = muted === null || !onToggle;
  const Icon = muted ? BellOff : Bell;
  return (
    <div className="app-contacts-tile-slot" title={unavailable ? 'Coming soon' : undefined}>
      <DetailTile
        icon={<Icon className="h-5 w-5" aria-hidden="true" />}
        label={muted ? 'Unmute' : 'Mute'}
        onClick={() => onToggle?.()}
        disabled={unavailable}
      />
    </div>
  );
}

export function SettingsTile({ onOpen }: { onOpen?: () => void }) {
  return (
    <DetailTile
      icon={<Settings className="h-5 w-5" aria-hidden="true" />}
      label="Settings"
      onClick={() => onOpen?.()}
      disabled={!onOpen}
    />
  );
}

function CopyTextButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      className="app-contacts-tile is-primary inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[8px] text-[13px] font-medium"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
      }}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Share tile: a small popover with the Kordi ID and a Copy button. */
export function ShareTile({ handle }: { handle: string | null }) {
  const { open, setOpen, slotProps } = usePopover();
  return (
    <div {...slotProps}>
      <DetailTile
        icon={<Share className="h-5 w-5" aria-hidden="true" />}
        label="Share"
        ariaHasPopup="dialog"
        ariaExpanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={!handle}
      />
      {open && handle ? (
        <div
          role="dialog"
          aria-label="Share Kordi ID"
          className="app-contacts-menu app-contact-share absolute left-1/2 top-[68px] z-10 w-[220px] -translate-x-1/2 rounded-[12px] p-3"
        >
          <code className="app-contact-share-code block select-all rounded-[8px] px-3 py-2.5 text-center text-[15px] font-medium tracking-[0.02em]">
            {handle}
          </code>
          <div className="mt-2">
            <CopyTextButton value={handle} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
