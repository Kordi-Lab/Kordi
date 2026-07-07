import { useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fileToAvatarDataUrl, setAvatarOverride } from './avatarOverrides';
import { getIdentityAvatarKey, IdentityAvatar, type IdentityAvatarProps } from './IdentityAvatar';

type EditableIdentityAvatarProps = IdentityAvatarProps & {
  label?: string;
  compact?: boolean;
  controlsClassName?: string;
};

export function EditableIdentityAvatar({ label = 'Avatar', compact = false, controlsClassName, ...avatarProps }: EditableIdentityAvatarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const normalizedSeed = avatarProps.seed.trim() || avatarProps.name?.trim() || `${avatarProps.kind}:unknown`;
  const avatarKey = getIdentityAvatarKey(avatarProps.kind, normalizedSeed, avatarProps.avatarKey);

  const handleFileChange = (file?: File) => {
    if (!file) return;

    setIsSaving(true);
    setError(null);
    void fileToAvatarDataUrl(file)
      .then((dataUrl) => setAvatarOverride(avatarKey, dataUrl))
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Could not use that image.');
      })
      .finally(() => {
        setIsSaving(false);
        if (inputRef.current) inputRef.current.value = '';
      });
  };

  return (
    <div className={cn('flex items-center gap-3', compact ? 'gap-2' : '')}>
      <div className="relative shrink-0">
        <IdentityAvatar {...avatarProps} avatarKey={avatarKey} />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="app-avatar-upload-button absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full border shadow-sm transition"
          aria-label={`Upload ${label.toLowerCase()}`}
          title={`Upload ${label.toLowerCase()}`}
        >
          <Camera className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className={cn('min-w-0', compact ? 'flex items-center gap-2' : 'space-y-1.5', controlsClassName)}>
        {!compact ? <div className="text-[12px] font-medium text-white">{label}</div> : null}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            className="hidden"
            onChange={(event) => handleFileChange(event.target.files?.[0])}
          />
          {isSaving ? <div className="text-[11px] leading-4 text-slate-400">Saving…</div> : null}
        </div>
        {error ? <div className="app-error-text max-w-[18rem] text-[11px] leading-4 text-rose-300">{error}</div> : null}
      </div>
    </div>
  );
}
