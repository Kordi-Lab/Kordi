import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, ImagePlus, LoaderCircle, Trash2 } from 'lucide-react';
import type { ParticipantSpaceAvatar } from '@/kordi-app/types';
import { ErrorLine } from '@/components/ui/ErrorLine';
import { cn } from '@/lib/utils';
import { isNativeDesktopShell } from '@/lib/desktop';
import { fileToAvatarDataUrl } from './avatarOverrides';
import { GroupAvatar } from './GroupAvatar';
import { groupAvatarMenuBounds, groupAvatarMenuPlacement, type MenuPlacement } from './groupAvatarMenuPlacement';

/** The menu is portaled to the body, so it counts as part of the editor too. */
function withinEditor(target: EventTarget | null, ...parts: (HTMLElement | null)[]) {
  return target instanceof Node && parts.some((part) => part?.contains(target));
}

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
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  // The menu renders in a portal so a dialog's overflow cannot clip it,
  // placed against the avatar and kept inside the dialog and the window.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current;
      const surface = menu.current;
      if (!anchor || !surface) return;
      setPlacement(groupAvatarMenuPlacement(anchor.getBoundingClientRect(), { width: surface.offsetWidth, height: surface.offsetHeight }, groupAvatarMenuBounds(anchor)));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, imageUrl]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!withinEditor(event.target, root.current, menu.current)) setOpen(false);
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
      if (event.relatedTarget && !withinEditor(event.relatedTarget, root.current, menu.current)) setOpen(false);
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
        className={cn('app-group-avatar-edit relative inline-flex shrink-0 rounded-[17%] disabled:cursor-wait disabled:opacity-60', avatarClassName)}
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
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Group avatar"
          data-group-avatar-menu="true"
          data-menu-side={placement?.side}
          className="app-transient-surface app-dense-menu app-group-avatar-menu fixed z-[70]"
          style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, opacity: placement ? undefined : 0 }}
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
          <button type="button" role="menuitem" className="app-dense-menu-row" onClick={() => {
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
          }}><ImagePlus aria-hidden="true" />Upload photo</button>
          {imageUrl ? (
            <button type="button" role="menuitem" className="app-dense-menu-row app-dense-menu-danger" onClick={() => void run(onRemove)}><Trash2 aria-hidden="true" />Remove image</button>
          ) : null}
        </div>,
        document.body,
      ) : null}
      {error ? <ErrorLine className="mt-2 max-w-60">{error}</ErrorLine> : null}
      {busy ? <span className="sr-only" aria-live="polite">Updating group avatar.</span> : null}
    </div>
  );
}
