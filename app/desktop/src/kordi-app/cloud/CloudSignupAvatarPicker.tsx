import { useState } from 'react';
import { Dice5, UserRound } from 'lucide-react';

export function CloudSignupAvatarPicker({
  generatedImageUrl,
  onRegenerate,
  disabled,
}: {
  generatedImageUrl: string;
  onRegenerate: () => void;
  disabled?: boolean;
}) {
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const imageUrl = generatedImageUrl;
  const imageReady = loadedImageUrl === imageUrl;

  return (
    <div className="relative flex h-12 w-20 items-center gap-1">
      <div
        className="app-cloud-login-avatar relative block h-12 w-12 shrink-0 overflow-hidden rounded-full border border-[var(--app-cloud-login-inner-border)] bg-[var(--app-cloud-login-sunk-bg)]"
      >
        <span className="absolute inset-0 grid place-items-center text-[var(--utility-meta-text)]" aria-hidden="true">
          <UserRound className="h-5 w-5" strokeWidth={1.8} />
        </span>
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
      </div>
      <div className="flex h-12 w-7 shrink-0 flex-col">
        <button
          type="button"
          title="Generate another avatar"
          aria-label="Generate another avatar"
          data-cloud-signup-avatar-reroll="true"
          disabled={disabled}
          onClick={onRegenerate}
          className="grid h-12 w-7 place-items-center rounded-full border border-[var(--app-cloud-login-inner-border)] bg-[var(--app-cloud-login-raised-bg)] text-muted-foreground transition hover:-rotate-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-cloud-login-focus-ring-visible)] motion-reduce:transform-none disabled:opacity-50"
        >
          <Dice5 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
