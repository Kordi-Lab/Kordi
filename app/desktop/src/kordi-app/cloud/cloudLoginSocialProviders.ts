import type { ComponentType } from 'react';

import type { CloudOAuthProvider } from '@/features/cloud/authClient';

import { AppleMark, GitHubMark, GoogleMark } from './CloudLoginMarks';

type SocialProvider = {
  id: CloudOAuthProvider;
  label: string;
  actionLabel: string;
  Mark: ComponentType;
  /** Shown only when the server lists it; Google and GitHub always show. */
  serverConfigured?: boolean;
};

export const SOCIAL_LOGIN_PROVIDERS: ReadonlyArray<SocialProvider> = [
  { id: 'google', label: 'Google', actionLabel: 'Continue with Google', Mark: GoogleMark },
  { id: 'github', label: 'GitHub', actionLabel: 'Continue with GitHub', Mark: GitHubMark },
  { id: 'apple', label: 'Apple', actionLabel: 'Sign in with Apple', Mark: AppleMark, serverConfigured: true },
];

/** Providers the login page can start. Apple needs the server to list it. */
export function enabledSocialLoginProviders(
  canSignIn: boolean,
  oauthProviders: readonly CloudOAuthProvider[] = [],
): CloudOAuthProvider[] {
  if (!canSignIn) return [];
  return SOCIAL_LOGIN_PROVIDERS
    .filter((provider) => !provider.serverConfigured || oauthProviders.includes(provider.id))
    .map((provider) => provider.id);
}
