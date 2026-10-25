import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { BIRD_CANONICAL_AVATAR_STYLE, generatedAvatarPreviewUrl } from '@/features/cloud/canonicalAvatar';
import {
  BIRD_PALETTES,
  BIRD_SPECIES,
  BIRD_TONES,
  birdAvatarFromSeed,
  birdAvatarSeed,
  randomBirdAvatarSeed,
  type BirdAvatar,
} from '@/features/cloud/birdAvatars';
import { cn } from '@/lib/utils';
import { IdentityAvatar } from './IdentityAvatar';

const PICKER_WIDTH = 316;
const VIEWPORT_GUTTER = 12;
const SELECTED_RING = 'shadow-[0_0_0_2px_var(--app-transient-surface-bg),0_0_0_4px_var(--app-accent)]';

export type AgentAvatarPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger the popover hangs under; clicks on it do not count as outside clicks. */
  anchorRef: RefObject<HTMLElement | null>;
  /** The element the popover is placed under; defaults to the trigger. */
  placementRef?: RefObject<HTMLElement | null>;
  currentSeed?: string | null;
  onPick: (seed: string) => void;
  onUpload?: () => void;
};

function useAnchoredPosition(open: boolean, anchorRef: RefObject<HTMLElement | null>) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - PICKER_WIDTH - VIEWPORT_GUTTER);
      setPosition({ top: rect.bottom + 8, left: Math.min(Math.max(VIEWPORT_GUTTER, rect.left), maxLeft) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef]);
  return position;
}

/** Bird avatar picker for agents: tone, species and colour apply at once and keep the popover open. */
export function AgentAvatarPicker({ open, onOpenChange, anchorRef, placementRef, currentSeed, onPick, onUpload }: AgentAvatarPickerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<BirdAvatar>(() => birdAvatarFromSeed(currentSeed ?? ''));
  const [syncedSeed, setSyncedSeed] = useState(currentSeed);
  const position = useAnchoredPosition(open, placementRef ?? anchorRef);

  // Follow a new saved seed from outside, as React's "adjust state on prop change" pattern.
  if (syncedSeed !== currentSeed) {
    setSyncedSeed(currentSeed);
    setSelection(birdAvatarFromSeed(currentSeed ?? ''));
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !ref.current?.contains(target) && !anchorRef.current?.contains(target)) onOpenChange(false);
    };
    // Capture, so Escape closes the popover before a dialog behind it sees the key.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onOpenChange(false);
      anchorRef.current?.focus();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchorRef, onOpenChange]);

  if (!open || typeof document === 'undefined') return null;

  const pick = (next: Partial<BirdAvatar>) => {
    const bird = { ...selection, ...next };
    setSelection(bird);
    onPick(birdAvatarSeed(bird.species, bird.tone, bird.palette));
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Avatar"
      className="app-transient-surface fixed z-[2147483000] rounded-2xl border p-4"
      style={{ width: PICKER_WIDTH, top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
    >
      <div className="mb-3 text-[13px] font-semibold">Avatar</div>
      <div className="mb-3.5 flex rounded-[9px] bg-[var(--app-transient-raised-bg)] p-[3px]" role="radiogroup" aria-label="Tone">
        {BIRD_TONES.map((tone) => (
          <button
            key={tone.key}
            type="button"
            role="radio"
            aria-checked={selection.tone === tone.key}
            className={cn(
              'flex-1 rounded-[7px] py-[5px] text-[12px] transition',
              selection.tone === tone.key
                ? 'bg-[var(--app-transient-selected-bg)] text-[var(--app-transient-text)] shadow-sm'
                : 'text-[var(--app-transient-muted-text)] hover:text-[var(--app-transient-text)]',
            )}
            onClick={() => pick({ tone: tone.key })}
          >
            {tone.name}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-x-1.5 gap-y-2.5">
        {BIRD_SPECIES.map((species) => {
          const seed = birdAvatarSeed(species.key, selection.tone, selection.palette);
          const selected = selection.species === species.key;
          return (
            <button
              key={species.key}
              type="button"
              aria-label={species.name}
              aria-pressed={selected}
              data-bird-species={species.key}
              className="flex flex-col items-center gap-1 rounded-[10px] py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-transient-focus-ring)]"
              onClick={() => pick({ species: species.key })}
            >
              <IdentityAvatar
                kind="agent"
                seed={seed}
                imageUrl={generatedAvatarPreviewUrl(BIRD_CANONICAL_AVATAR_STYLE, seed)}
                className={cn('h-14 w-14 transition-shadow', selected && SELECTED_RING)}
              />
              <span className="whitespace-nowrap text-[11px] leading-[1.2] tracking-[-0.01em] text-[var(--app-transient-muted-text)]">{species.name}</span>
            </button>
          );
        })}
      </div>
      <div className="mx-1 mb-2.5 mt-4 flex justify-between" role="radiogroup" aria-label="Color">
        {BIRD_PALETTES.map((palette) => (
          <button
            key={palette.key}
            type="button"
            role="radio"
            aria-checked={selection.palette === palette.key}
            aria-label={palette.name}
            data-bird-palette={palette.key}
            className={cn(
              'h-6 w-6 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.13)] transition-shadow',
              selection.palette === palette.key && 'shadow-[inset_0_0_0_1px_rgb(0_0_0/0.13),0_0_0_2px_var(--app-transient-surface-bg),0_0_0_4px_var(--app-accent)]',
            )}
            style={{ background: palette.background }}
            onClick={() => pick({ palette: palette.key })}
          />
        ))}
      </div>
      {onUpload ? (
        <button
          type="button"
          className="mt-1 block w-full border-t border-[var(--app-transient-divider)] px-1.5 py-[9px] text-left text-[13px] hover:bg-[var(--app-transient-hover-bg)]"
          onClick={() => {
            onOpenChange(false);
            onUpload();
          }}
        >
          Upload photo
        </button>
      ) : null}
      <button
        type="button"
        className={cn('block w-full border-t border-[var(--app-transient-divider)] px-1.5 py-[9px] text-left text-[13px] hover:bg-[var(--app-transient-hover-bg)]', !onUpload && 'mt-1')}
        onClick={() => {
          const seed = randomBirdAvatarSeed();
          setSelection(birdAvatarFromSeed(seed));
          onPick(seed);
        }}
      >
        Shuffle
      </button>
    </div>,
    document.body,
  );
}
