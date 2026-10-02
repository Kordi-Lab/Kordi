import { useRef, useState } from 'react';
import type { ParticipantSpaceAvatar } from '@/kordi-app/types';
import { fileToAvatarDataUrl } from './avatarOverrides';
import { GroupAvatar } from './GroupAvatar';

export function GroupAvatarEditor({ avatars, imageUrl, name, disabled, onUpload, onRemove }: {
  avatars: readonly ParticipantSpaceAvatar[];
  imageUrl?: string | null;
  name: string;
  disabled?: boolean;
  onUpload: (dataUrl: string) => Promise<void> | void;
  onRemove: () => Promise<void> | void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void> | void) => {
    if (disabled || busy) return;
    setBusy(true); setError(null);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not update the group image.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <div className="mb-3 grid gap-1.5">
      <div className="flex items-center gap-3">
        <GroupAvatar avatars={avatars} imageUrl={imageUrl} name={name} className="h-14 w-14" />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 text-[12px] font-semibold">Group avatar</div>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Group image file" disabled={disabled || busy} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void run(async () => { if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.'); await onUpload(await fileToAvatarDataUrl(file)); });
          }} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="app-button-primary rounded-[8px] px-2.5 py-1.5 text-[11px] disabled:opacity-50" disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? 'Saving…' : 'Choose image'}</button>
            {imageUrl ? <button type="button" className="app-button-quiet rounded-[8px] px-2.5 py-1.5 text-[11px] disabled:opacity-50" disabled={disabled || busy} onClick={() => void run(onRemove)}>Remove image</button> : null}
          </div>
          <div className="mt-1 text-[10.5px] text-[var(--utility-muted-text)]">{imageUrl ? 'Remove to restore member avatars.' : 'Optional. Uses member avatars by default.'}</div>
        </div>
      </div>
      {error ? <div role="alert" className="app-error-text text-[11px]">{error}</div> : null}
      {busy ? <span className="sr-only" aria-live="polite">Saving group avatar.</span> : null}
    </div>
  );
}
