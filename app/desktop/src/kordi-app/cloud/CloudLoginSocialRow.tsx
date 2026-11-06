import type { CloudOAuthProvider } from '@/features/cloud/authClient';

import { enabledSocialLoginProviders, SOCIAL_LOGIN_PROVIDERS } from './cloudLoginSocialProviders';

export function CloudLoginSocialRow({
  canSignIn,
  oauthProviders,
  busy,
  activeProvider,
  onSelect,
}: {
  canSignIn: boolean;
  oauthProviders?: readonly CloudOAuthProvider[];
  busy: boolean;
  activeProvider: CloudOAuthProvider | null;
  onSelect: (provider: CloudOAuthProvider) => void;
}) {
  const enabled = enabledSocialLoginProviders(canSignIn, oauthProviders);
  // A server-configured provider the server does not offer is left out, not greyed.
  const shown = SOCIAL_LOGIN_PROVIDERS.filter((provider) => !provider.serverConfigured || enabled.includes(provider.id));
  return (
    <div className="mt-7 flex items-center justify-center gap-6">
      {shown.map((provider) => {
        const isAvailable = enabled.includes(provider.id);
        const accessibleLabel = isAvailable
          ? provider.actionLabel
          : `${provider.label} sign-in unavailable; use email and password`;
        return (
          <button
            key={provider.id}
            type="button"
            disabled={!isAvailable || busy}
            title={accessibleLabel}
            aria-label={accessibleLabel}
            data-provider={provider.id}
            data-provider-available={isAvailable ? 'true' : 'false'}
            onClick={() => onSelect(provider.id)}
            className={[
              'app-cloud-login-social-pill flex h-10 w-10 items-center justify-center rounded-full transition duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-cloud-login-focus-ring-visible)]',
              isAvailable
                ? 'hover:scale-105 disabled:cursor-wait disabled:opacity-55'
                : 'cursor-not-allowed opacity-35 grayscale',
              'text-foreground',
            ].join(' ')}
          >
            <provider.Mark />
            {activeProvider === provider.id ? <span className="sr-only">Starting…</span> : null}
          </button>
        );
      })}
    </div>
  );
}
