import { useEffect, useLayoutEffect } from 'react';

import {
  canonicalAvatarSeed,
  canonicalIdentityDisplayName,
  canonicalLocalAgentAvatarSeed,
  canonicalProfileImageUrl,
} from '@/app/useKordiAppModelHelpers';
import type { CloudAccount } from '@/features/cloud/authClient';
import { cloudAvatarImageUrl } from '@/features/cloud/avatar';
import { canonicalAvatarImageSource } from '@/features/cloud/canonicalAvatar';
import {
  setLocalProfileAvatarSeed,
} from '@/kordi-app/components/IdentityAvatar';
import { setActiveLocalProfileIdentity } from '@/kordi-app/components/localProfileIdentity';
import type {
  CanonicalSessionState,
  DesktopCollaborationState,
} from '@/kordi-app/types';

type KordiProfileAvatarStateArgs = {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null;
  collaborationState: DesktopCollaborationState | null;
};

export function resolveKordiProfileAvatarState({
  account,
  canonicalState,
  collaborationState,
}: KordiProfileAvatarStateArgs) {
  const host = collaborationState?.hosts.find(
    (candidate) => candidate.id === collaborationState.activeHostId,
  ) ?? collaborationState?.hosts[0] ?? null;
  const activeAgentId = host?.activeAgentId ?? null;
  const agent = host?.agents.find((candidate) => candidate.id === activeAgentId)
    ?? host?.agents.find((candidate) => candidate.isActive)
    ?? host?.agents.find((candidate) => candidate.isDefault)
    ?? host?.agents[0]
    ?? null;
  const canonicalProfileAvatarSeed = canonicalAvatarSeed(
    canonicalState,
    canonicalState?.profile.humanIdentityId,
  ) || host?.humanId?.trim()
    || canonicalState?.profile.id?.trim()
    || null;
  const canonicalProfileImage = canonicalProfileImageUrl(
    canonicalState,
    canonicalState?.profile.humanIdentityId,
  ) || host?.profileImageUrl?.trim()
    || null;
  const cloudProfileAvatar = account ? {
    seed: account.avatar.seed,
    imageUrl: cloudAvatarImageUrl(canonicalAvatarImageSource(account.avatar)),
    shouldPersistSeed: false,
  } : null;
  const localAgentIdentity = canonicalState?.identities.find((identity) => (
    identity.kind === 'agent'
    && identity.id === canonicalState.profile.activeAgentIdentityId
  )) ?? canonicalState?.identities.find((identity) => (
    identity.kind === 'agent'
    && identity.source === 'local'
    && identity.ownerIdentityId === canonicalState.profile.humanIdentityId
  ));

  return {
    localProfileAvatarSeed:
      cloudProfileAvatar?.seed ?? canonicalProfileAvatarSeed,
    localProfileImageUrl:
      cloudProfileAvatar?.imageUrl ?? canonicalProfileImage,
    localProfileDisplayName: account?.displayName?.trim()
      || account?.primaryEmail?.trim()
      || canonicalIdentityDisplayName(
        canonicalState,
        canonicalState?.profile.humanIdentityId,
      )?.trim()
      || host?.ownerName?.trim()
      || null,
    localAgentDisplayName: localAgentIdentity?.displayName?.trim()
      || agent?.label?.trim()
      || host?.displayName?.trim()
      || null,
    localAgentAvatarSeed: canonicalLocalAgentAvatarSeed(canonicalState)
      || agent?.id?.trim()
      || host?.activeAgentId?.trim()
      || agent?.nodeId?.trim()
      || host?.nodeId?.trim()
      || null,
    shouldPersistProfileSeed: cloudProfileAvatar?.shouldPersistSeed ?? false,
  };
}

export function useKordiProfileAvatarState({
  account,
  canonicalState,
  collaborationState,
}: KordiProfileAvatarStateArgs) {
  const state = resolveKordiProfileAvatarState({
    account,
    canonicalState,
    collaborationState,
  });

  useEffect(() => {
    if (!state.shouldPersistProfileSeed) return;
    setLocalProfileAvatarSeed(state.localProfileAvatarSeed);
  }, [state.localProfileAvatarSeed, state.shouldPersistProfileSeed]);

  useLayoutEffect(() => {
    setActiveLocalProfileIdentity({
      avatarSeed: state.localProfileAvatarSeed,
      displayName: state.localProfileDisplayName,
      profileImageUrl: state.localProfileImageUrl,
    });
  }, [
    state.localProfileAvatarSeed,
    state.localProfileDisplayName,
    state.localProfileImageUrl,
  ]);

  return state;
}
