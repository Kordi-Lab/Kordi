import { useRef, useState } from 'react';
import { Camera, Dice5 } from 'lucide-react';
import { fileToAvatarDataUrl, setAvatarOverride } from './avatarOverrides';
import { getIdentityAvatarKey, IdentityAvatar, type IdentityAvatarProps } from './IdentityAvatar';

type EditableIdentityAvatarProps = IdentityAvatarProps & {
  label?: string;
  onUpload?: (dataUrl: string) => Promise<void> | void;
  onGenerate?: () => Promise<void> | void;
  generateLabel?: string;
};

export function EditableIdentityAvatar({
  label = 'Avatar',
  onUpload,
  onGenerate,
  generateLabel = 'Random avatar',
  ...avatarProps
}: EditableIdentityAvatarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const normalizedSeed = avatarProps.seed.trim() || avatarProps.name?.trim() || `${avatarProps.kind}:unknown`;
  const avatarKey = getIdentityAvatarKey(avatarProps.kind, normalizedSeed, avatarProps.avatarKey);

  const handleFileChange = (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPEG, or WebP image.');
      return;
    }

    setIsSaving(true);
    setError(null);
    void fileToAvatarDataUrl(file)
      .then(async (dataUrl) => {
        if (onUpload) {
          await onUpload(dataUrl);
        } else {
          setAvatarOverride(avatarKey, dataUrl);
        }
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Could not use that image.');
      })
      .finally(() => {
        setIsSaving(false);
        if (inputRef.current) inputRef.current.value = '';
      });
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex items-stretch gap-1">
        <IdentityAvatar {...avatarProps} avatarKey={avatarKey} />
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(event) => handleFileChange(event.currentTarget.files?.[0])}
        />
        <div className="flex w-7 shrink-0 flex-col overflow-hidden rounded-full border border-[var(--app-cloud-login-inner-border)] bg-[var(--app-cloud-login-raised-bg)] text-muted-foreground">
          {onGenerate ? (
            <button
              type="button"
              className="grid min-h-6 flex-1 place-items-center border-b border-[var(--app-cloud-login-inner-border)] transition hover:bg-[var(--app-cloud-login-sunk-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-cloud-login-focus-ring-visible)] disabled:opacity-50"
              disabled={isSaving}
              title={generateLabel}
              aria-label={generateLabel}
              onClick={() => {
                setIsSaving(true);
                setError(null);
                void Promise.resolve(onGenerate())
                  .catch((caught: unknown) => {
                    setError(caught instanceof Error ? caught.message : 'Could not create a random avatar.');
                  })
                  .finally(() => setIsSaving(false));
              }}
            >
              <Dice5 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="grid min-h-6 flex-1 place-items-center transition hover:bg-[var(--app-cloud-login-sunk-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-cloud-login-focus-ring-visible)] disabled:opacity-50"
            disabled={isSaving}
            aria-label={`Upload ${label.toLowerCase()}`}
            title={`Upload ${label.toLowerCase()}`}
          >
            <Camera className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>
      {isSaving ? <span className="sr-only" aria-live="polite">Saving avatar…</span> : null}
      {error ? <div className="app-error-text max-w-[18rem] text-[11px] leading-4 text-rose-300">{error}</div> : null}
    </div>
  );
}
