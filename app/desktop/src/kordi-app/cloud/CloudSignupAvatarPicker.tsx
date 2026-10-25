import { useRef, useState } from 'react';
import { Bird, Camera, Dice5, UserRound } from 'lucide-react';
import { AgentAvatarPicker } from '../components/AgentAvatarPicker';
import { fileToAvatarDataUrl } from '../components/avatarOverrides';

export function CloudSignupAvatarPicker({
  imageUrl,
  onUpload,
  onRegenerate,
  uploadLabel = 'Upload avatar',
  regenerateLabel = 'Random avatar',
  disabled,
  onPick,
  currentSeed,
}: {
  imageUrl: string;
  onUpload: (dataUrl: string) => Promise<void> | void;
  onRegenerate: () => void;
  uploadLabel?: string;
  regenerateLabel?: string;
  disabled?: boolean;
  /** Agents: the top button opens the bird picker instead of rolling a random avatar. */
  onPick?: (seed: string) => void;
  currentSeed?: string | null;
}) {
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const imageReady = loadedImageUrl === imageUrl;

  const upload = (file?: File) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    void fileToAvatarDataUrl(file)
      .then(onUpload)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not use that image.'))
      .finally(() => setUploading(false));
  };

  return (
    <div ref={controlRef} className="relative flex h-12 w-20 items-center gap-1">
      <div className="app-cloud-login-avatar relative block h-12 w-12 shrink-0 overflow-hidden rounded-full border border-[var(--app-cloud-login-inner-border)] bg-[var(--app-cloud-login-sunk-bg)]">
        <span className="absolute inset-0 grid place-items-center text-[var(--utility-meta-text)]" aria-hidden="true">
          <UserRound className="h-5 w-5" strokeWidth={1.8} />
        </span>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            className={`absolute inset-0 h-full w-full object-cover transition-opacity ${imageReady ? 'opacity-100' : 'opacity-0'}`}
            draggable={false}
            onLoad={() => setLoadedImageUrl(imageUrl)}
            onError={() => {
              if (loadedImageUrl === imageUrl) setLoadedImageUrl(null);
            }}
          />
        ) : null}
      </div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Choose avatar image" disabled={disabled || uploading} onChange={(event) => { upload(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
      <div className="flex h-12 w-7 shrink-0 flex-col overflow-hidden rounded-full border border-[var(--app-cloud-login-inner-border)] bg-[var(--app-cloud-login-raised-bg)] text-muted-foreground">
        <button
          ref={pickerTriggerRef}
          type="button"
          title={onPick ? 'Choose avatar' : regenerateLabel}
          aria-label={onPick ? 'Choose avatar' : regenerateLabel}
          aria-haspopup={onPick ? 'dialog' : undefined}
          aria-expanded={onPick ? pickerOpen : undefined}
          data-cloud-signup-avatar-reroll={onPick ? undefined : 'true'}
          disabled={disabled || uploading}
          onClick={onPick ? () => setPickerOpen((current) => !current) : onRegenerate}
          className="grid h-6 w-7 place-items-center border-b border-[var(--app-cloud-login-inner-border)] transition hover:bg-[var(--app-cloud-login-sunk-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-cloud-login-focus-ring-visible)] disabled:opacity-50"
        >
          {onPick
            ? <Bird className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            : <Dice5 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
        </button>
        <button
          type="button"
          title={uploadLabel}
          aria-label={uploadLabel}
          data-cloud-signup-avatar-upload="true"
          disabled={disabled || uploading}
          onClick={() => inputRef.current?.click()}
          className="grid h-6 w-7 place-items-center transition hover:bg-[var(--app-cloud-login-sunk-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-cloud-login-focus-ring-visible)] disabled:opacity-50"
        >
          <Camera className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {onPick ? (
        <AgentAvatarPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          anchorRef={pickerTriggerRef}
          placementRef={controlRef}
          currentSeed={currentSeed}
          onPick={onPick}
          onUpload={() => inputRef.current?.click()}
        />
      ) : null}
      {error ? <span role="alert" className="app-error-text absolute left-0 top-full z-10 mt-1 w-48 rounded-lg bg-[var(--app-cloud-login-raised-bg)] px-2 py-1 text-[11px]">{error}</span> : null}
    </div>
  );
}
