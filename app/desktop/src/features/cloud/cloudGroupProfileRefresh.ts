import { useEffect, useRef, type MutableRefObject } from 'react';

import { upsertCanonicalIdentityFast } from '@/lib/desktop';
import type {
  CanonicalIdentity,
  CanonicalSessionState,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import type { CloudAccount, CloudAuthClient, CloudPublicProfile } from './authClient';
import { upsertCanonicalIdentityIntoLocalState } from './cloudCanonicalStateMerge';
import { CLOUD_DIRECTORY_SYNC_EVENT, type CloudDirectorySyncDetail } from './cloudDeviceEvents';
import type {
  CanonicalSessionStateSetter,
  CloudGroupSessionPreparationCache,
} from './cloudGroupControlContext';
import {
  cloudGroupAgentAvatarsByAccount,
  cloudGroupAgentProfileImageUrl,
  cloudGroupIdentityRequest,
} from './cloudGroupIdentity';
import { cloudGroupParticipantsWithProfiles, type CloudGroupParticipant } from './cloudGroupMessages';
import { loadSession } from './session';

/** Collects a burst of directory events into one refresh. */
export const CLOUD_GROUP_PROFILE_REFRESH_DELAY_MS = 300;

function metadataRecord(identity: CanonicalIdentity): Record<string, unknown> {
  const value = identity.metadata;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function identityRequest(identity: CanonicalIdentity, profileImageUrl: string | null): UpsertCanonicalIdentityRequest {
  return {
    id: identity.id,
    kind: identity.kind === 'human' ? 'human' : 'agent',
    displayName: identity.displayName,
    ownerIdentityId: identity.ownerIdentityId ?? null,
    source: identity.source,
    sourceHostId: identity.sourceHostId ?? null,
    sourceIdentityId: identity.sourceIdentityId ?? null,
    humanId: identity.humanId ?? null,
    agentId: identity.agentId ?? null,
    avatarKey: identity.avatarKey,
    profileImageUrl,
    metadata: identity.metadata,
  };
}

function changes(identity: CanonicalIdentity | undefined, request: UpsertCanonicalIdentityRequest) {
  return !identity
    || identity.displayName !== request.displayName
    || (identity.profileImageUrl ?? null) !== (request.profileImageUrl ?? null)
    || JSON.stringify(identity.metadata ?? null) !== JSON.stringify(request.metadata ?? null);
}

/**
 * The identity writes that redraw a member's group rows with their refreshed profile: their
 * default agent's replies and, given the member as a group prepared them, their own rows.
 * Rows read the picture from the identity on every render, so no message is rewritten.
 */
export function cloudGroupProfileIdentityRefreshes(input: {
  identities: readonly CanonicalIdentity[];
  profile: CloudPublicProfile;
  /** The member with `profile` applied. */
  participant?: CloudGroupParticipant | null;
  account: CloudAccount;
  localHumanIdentityId: string;
}): UpsertCanonicalIdentityRequest[] {
  const { identities, profile, participant, account, localHumanIdentityId } = input;
  const agentAvatar = cloudGroupAgentAvatarsByAccount([], [profile]).get(profile.accountId);
  const requests = identities
    .filter((identity) => identity.kind === 'agent'
      && identity.humanId === profile.accountId
      && metadataRecord(identity).cloudGroupAgent === true)
    .map((identity) => [identity, identityRequest(
      identity,
      cloudGroupAgentProfileImageUrl(agentAvatar, identity.agentId ?? ''),
    )] as const)
    .filter(([identity, request]) => changes(identity, request))
    .map(([, request]) => request);
  if (participant) {
    const request = cloudGroupIdentityRequest(participant, account, localHumanIdentityId);
    if (changes(identities.find((identity) => identity.id === request.id), request)) requests.push(request);
  }
  return requests;
}

/**
 * Applies a refreshed profile to every prepared group that holds the member, so the next
 * message there reuses fresh data. Returns the member with the profile applied.
 */
function refreshPreparations(
  preparationCache: CloudGroupSessionPreparationCache,
  profile: CloudPublicProfile,
): CloudGroupParticipant | null {
  const { accountId } = profile;
  const agentAvatar = cloudGroupAgentAvatarsByAccount([], [profile]).get(accountId);
  let refreshed: CloudGroupParticipant | null = null;
  for (const [groupId, preparation] of preparationCache) {
    const member = preparation.participantByAccount.get(accountId);
    if (!member) continue;
    const participant = cloudGroupParticipantsWithProfiles([member], [profile])[0] ?? member;
    refreshed ??= participant;
    const agentAvatarByAccount = new Map(preparation.agentAvatarByAccount);
    if (agentAvatar) agentAvatarByAccount.set(accountId, agentAvatar);
    else agentAvatarByAccount.delete(accountId);
    preparationCache.set(groupId, {
      ...preparation,
      participantByAccount: new Map(preparation.participantByAccount).set(accountId, participant),
      agentAvatarByAccount,
    });
  }
  return refreshed;
}

export type CloudGroupProfileRefreshInput = {
  accountIds: readonly string[];
  token: string;
  account: CloudAccount;
  client: Pick<CloudAuthClient, 'getProfile'>;
  profileCache: Map<string, CloudPublicProfile>;
  preparationCache: CloudGroupSessionPreparationCache;
  getState(): CanonicalSessionState | null;
  setState: CanonicalSessionStateSetter;
};

/**
 * Refetches the changed members that group sessions loaded, then redraws their rows and
 * refreshes the prepared groups that hold them. Accounts no group loaded are skipped; a failed
 * fetch keeps the cached profile.
 */
export async function refreshCloudGroupProfiles(input: CloudGroupProfileRefreshInput): Promise<string[]> {
  const { account, client, profileCache, preparationCache } = input;
  const accountIds = [...new Set(input.accountIds.map((id) => id.trim()))]
    .filter((id) => id && id !== account.accountId && profileCache.has(id));
  const refreshed: string[] = [];
  await Promise.all(accountIds.map(async (accountId) => {
    let profile: CloudPublicProfile;
    try {
      profile = await client.getProfile(input.token, accountId);
    } catch {
      return;
    }
    profileCache.set(accountId, profile);
    const participant = refreshPreparations(preparationCache, profile);
    const state = input.getState();
    const localHumanIdentityId = state?.profile.humanIdentityId?.trim();
    if (!state || !localHumanIdentityId) return;
    const requests = cloudGroupProfileIdentityRefreshes({
      identities: state.identities,
      profile,
      participant,
      account,
      localHumanIdentityId,
    });
    for (const request of requests) {
      const identity = await upsertCanonicalIdentityFast(request);
      input.setState((current) => upsertCanonicalIdentityIntoLocalState(current, identity));
    }
    refreshed.push(accountId);
  }));
  return refreshed;
}

/** Keeps group pictures live: a member's later profile change redraws their rows without a restart. */
export function useCloudGroupProfileRefresh(input: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  profileCacheRef: MutableRefObject<Map<string, CloudPublicProfile>>;
  preparationCacheRef: MutableRefObject<{ entries: CloudGroupSessionPreparationCache }>;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  setState: CanonicalSessionStateSetter;
}) {
  const { account, client, profileCacheRef, preparationCacheRef, canonicalStateRef, setState } = input;
  // An account refresh replaces the object; only a different account restarts the listener.
  const accountRef = useRef(account);
  useEffect(() => { accountRef.current = account; }, [account]);
  const accountId = account?.accountId ?? null;
  useEffect(() => {
    if (!accountId || typeof window === 'undefined') return;
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    const flush = async () => {
      timer = null;
      const accountIds = [...pending];
      pending.clear();
      const session = await loadSession();
      const account = accountRef.current;
      if (!active || !session?.token || !account || session.accountId !== accountId || account.accountId !== accountId) return;
      await refreshCloudGroupProfiles({
        accountIds,
        token: session.token,
        account,
        client,
        profileCache: profileCacheRef.current,
        preparationCache: preparationCacheRef.current.entries,
        getState: () => canonicalStateRef.current,
        setState,
      }).catch(() => undefined);
    };
    const onDirectoryChanged = (event: Event) => {
      const accountIds = (event as CustomEvent<CloudDirectorySyncDetail | null>).detail?.accountIds ?? [];
      for (const changed of accountIds) {
        if (changed !== accountId && profileCacheRef.current.has(changed)) pending.add(changed);
      }
      if (pending.size > 0 && timer === null) {
        timer = setTimeout(() => { void flush(); }, CLOUD_GROUP_PROFILE_REFRESH_DELAY_MS);
      }
    };
    window.addEventListener(CLOUD_DIRECTORY_SYNC_EVENT, onDirectoryChanged);
    return () => {
      active = false;
      window.removeEventListener(CLOUD_DIRECTORY_SYNC_EVENT, onDirectoryChanged);
      if (timer !== null) clearTimeout(timer);
    };
  }, [accountId, canonicalStateRef, client, preparationCacheRef, profileCacheRef, setState]);
}
