// Login-free synthetic preview of the agent bird avatar picker. Picks and uploads
// stay in this page; it needs no session.
//   ?theme=light|dark
//   ?open=1  opens the picker on load
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { BIRD_CANONICAL_AVATAR_STYLE, generatedAvatarPreviewUrl } from '../../src/features/cloud/canonicalAvatar';
import { EditableIdentityAvatar } from '../../src/kordi-app/components/EditableIdentityAvatar';

const params = new URLSearchParams(window.location.search);
const requestedTheme = params.get('theme');
const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
const theme: 'light' | 'dark' = requestedTheme === 'light' || requestedTheme === 'dark'
  ? requestedTheme
  : prefersLight ? 'light' : 'dark';
const openOnLoad = params.get('open') === '1';

// Match the body classes the app shell sets for the resolved theme.
document.body.classList.toggle('theme-light', theme === 'light');
document.body.classList.toggle('theme-dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

function AgentAvatarPickerPreview() {
  const [seed, setSeed] = useState('bird-jay-color-paper');
  const [uploaded, setUploaded] = useState<string | null>(null);

  useEffect(() => {
    if (openOnLoad) document.querySelector<HTMLButtonElement>('[aria-label="Choose avatar"]')?.click();
  }, []);

  return (
    <main className="min-h-screen bg-background p-10 text-foreground">
      <div className="app-transient-surface inline-flex items-center gap-4 rounded-2xl border p-6">
        <EditableIdentityAvatar
          kind="agent"
          seed="preview_agent_research"
          name="Research agent"
          label="Research agent avatar"
          imageUrl={uploaded ?? generatedAvatarPreviewUrl(BIRD_CANONICAL_AVATAR_STYLE, seed)}
          currentSeed={seed}
          onPick={(next) => {
            setUploaded(null);
            setSeed(next);
          }}
          onUpload={(dataUrl) => setUploaded(dataUrl)}
          className="h-12 w-12"
        />
        <div className="app-transient-muted text-[11px]" data-testid="picked-seed">{uploaded ? 'Uploaded photo' : seed}</div>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<AgentAvatarPickerPreview />);
