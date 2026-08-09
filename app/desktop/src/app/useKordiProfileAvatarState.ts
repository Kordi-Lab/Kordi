import { useEffect, useLayoutEffect } from 'react';

import {
  canonicalIdentityDisplayName,
} from '@/app/useKordiAppModelHelpers';
import {
  canonicalAvatarSeed,
  canonicalLocalAgentAvatarSeed,
  canonicalLocalAgentProfileImageUrl,
  canonicalProfileImageUrl,
} from '@/app/viewModels/canonicalIdentityAvatars';
import type { CloudAccount } from '@/features/cloud/authClient';
import { resolveCloudLocalProfileAvatar } from '@/features/cloud/avatar';
import {
  getPersistedLocalAgentAvatarSeed,
  setLocalAgentAvatarSeed,
  setLocalProfileAvatarSeed,
} from '@/kordi-app/components/avatarIdentity';
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
  const cloudProfileAvatar = resolveCloudLocalProfileAvatar({
    accountId: account?.accountId,
    avatarUrl: account?.avatarUrl,
    canonicalAvatarSeed: canonicalProfileAvatarSeed,
    canonicalProfileImageUrl: canonicalProfileImage,
  });
  const localAgentIdentity = canonicalState?.identities.find((identity) => (
    identity.kind === 'agent'
    && identity.id === canonicalState.profile.activeAgentIdentityId
  )) ?? canonicalState?.identities.find((identity) => (
    identity.kind === 'agent'
    && identity.source === 'local'
    && identity.ownerIdentityId === canonicalState.profile.humanIdentityId
  ));
  const canonicalAgentAvatarSeed = canonicalLocalAgentAvatarSeed(canonicalState);

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
    localAgentAvatarSeed: canonicalAgentAvatarSeed
      || getPersistedLocalAgentAvatarSeed()
      || agent?.id?.trim()
      || host?.activeAgentId?.trim()
      || agent?.nodeId?.trim()
      || host?.nodeId?.trim()
      || null,
    localAgentProfileImageUrl: agent?.profileImageUrl?.trim()
      || canonicalLocalAgentProfileImageUrl(canonicalState)
      || null,
    shouldPersistAgentSeed: Boolean(canonicalAgentAvatarSeed),
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
    if (state.shouldPersistAgentSeed) {
      setLocalAgentAvatarSeed(state.localAgentAvatarSeed);
    }
    setActiveLocalProfileIdentity({
      avatarSeed: state.localProfileAvatarSeed,
      displayName: state.localProfileDisplayName,
      profileImageUrl: state.localProfileImageUrl,
      agentAvatarSeed: state.localAgentAvatarSeed,
      agentProfileImageUrl: state.localAgentProfileImageUrl,
    });
  }, [
    state.localProfileAvatarSeed,
    state.localProfileDisplayName,
    state.localProfileImageUrl,
    state.localAgentAvatarSeed,
    state.localAgentProfileImageUrl,
    state.shouldPersistAgentSeed,
  ]);

  return state;
}
