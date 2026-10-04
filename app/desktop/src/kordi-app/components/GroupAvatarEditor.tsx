import { useEffect, useId, useRef, useState } from 'react';
import { Camera, LoaderCircle } from 'lucide-react';
import type { ParticipantSpaceAvatar } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { isNativeDesktopShell } from '@/lib/desktop';
import { fileToAvatarDataUrl } from './avatarOverrides';
import { GroupAvatar } from './GroupAvatar';

export function GroupAvatarEditor({ avatars, imageUrl, name, disabled, avatarClassName = 'h-14 w-14', onUpload, onRemove }: {
  avatars: readonly ParticipantSpaceAvatar[];
  imageUrl?: string | null;
  name: string;
  disabled?: boolean;
  avatarClassName?: string;
  onUpload: (dataUrl: string) => Promise<void> | void;
  onRemove: () => Promise<void> | void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  const closeMenu = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const run = async (action: () => Promise<void> | void) => {
    if (disabled || busy) return;
    closeMenu();
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not update the group image.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <div ref={root} className="relative inline-flex max-w-full flex-col items-center" onBlur={(event) => {
      // macOS WebKit can blur a button to no element on pointer down.
      // Keep the menu mounted until that pointer's click reaches its action.
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        ref={trigger}
        type="button"
        aria-label="Edit group avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={busy}
        title="Edit group avatar"
        className={cn('app-group-avatar-edit relative inline-flex shrink-0 rounded-[17%] outline-offset-4 disabled:cursor-wait disabled:opacity-60', avatarClassName)}
        disabled={disabled || busy}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <GroupAvatar avatars={avatars} imageUrl={imageUrl} name={name} className="h-full w-full" />
        <span aria-hidden="true" className="app-button-primary absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-[7px] border-2 border-[var(--app-transient-raised-bg)] shadow-sm">
          {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
        </span>
      </button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Group image file" disabled={disabled || busy} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) void run(async () => {
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
          await onUpload(await fileToAvatarDataUrl(file));
        });
      }} />
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Group avatar"
          data-group-avatar-menu="true"
          className="app-transient-surface app-frosted-popover absolute left-1/2 top-full z-[70] mt-2 w-40 -translate-x-1/2 rounded-[12px] p-1 text-left"
          onPointerDown={(event) => {
            // WebKit otherwise focuses the parent dialog on mouse down,
            // dismissing this menu before mouse up can click its action.
            if (event.button === 0) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeMenu();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          <button type="button" role="menuitem" className="app-transient-flat-action app-transient-action-row w-full rounded-[9px] px-3 py-2 text-left text-[12px]" onClick={() => {
            if (isNativeDesktopShell() && /Mac/i.test(window.navigator.platform)) {
              void run(async () => {
                const { pickNativeAvatarFile } = await import('@/lib/nativeAvatarPicker');
                const file = await pickNativeAvatarFile();
                if (file) await onUpload(await fileToAvatarDataUrl(file));
              });
            } else {
              closeMenu();
              input.current?.click();
            }
          }}>Upload photo</button>
          {imageUrl ? (
            <button type="button" role="menuitem" className="app-transient-row app-transient-row-danger app-transient-action-row w-full rounded-[9px] px-3 py-2 text-left text-[12px]" onClick={() => void run(onRemove)}>Remove image</button>
          ) : null}
        </div>
      ) : null}
      {error ? <div role="alert" className="app-error-text mt-2 max-w-60 text-[11px]">{error}</div> : null}
      {busy ? <span className="sr-only" aria-live="polite">Updating group avatar.</span> : null}
    </div>
  );
}
