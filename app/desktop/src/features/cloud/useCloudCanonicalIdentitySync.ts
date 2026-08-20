import {
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  adoptCloudProfileIdentity,
  upsertCanonicalIdentityFast,
} from '@/lib/desktop';
import {
  applyCanonicalProfileIdentityDelta,
} from '@/features/canonical/canonicalStateReducers';
import type {
  CanonicalSessionState,
  Contact,
} from '@/kordi-app/types';
import type {
  CloudAccount,
} from './authClient';
import { canonicalAvatarImageSource } from './canonicalAvatar';
import {
  cloudContactsToCanonicalIdentityRequests,
} from './cloudCollaborationState';
import {
  upsertCanonicalIdentityIntoLocalState,
} from './cloudCanonicalStateMerge';
import type {
  CloudProfileIdentityAdoptionCoordinator,
} from './cloudSyncCoordinator';

export function useCloudCanonicalIdentitySync({
  account,
  contacts,
  canonicalState,
  setCanonicalState,
  profileIdentityAdoptionCoordinator,
  reportWarning,
}: {
  account: CloudAccount | null;
  contacts: Contact[];
  canonicalState: CanonicalSessionState | null | undefined;
  setCanonicalState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  profileIdentityAdoptionCoordinator:
    CloudProfileIdentityAdoptionCoordinator;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const syncedContactIdentitySignatureRef =
    useRef<string | null>(null);
  const canonicalStateReady = Boolean(canonicalState);
  const localHumanIdentityId = account?.accountId
    ? `human:${account.accountId}`
    : canonicalState?.profile.humanIdentityId?.trim() || '';
  const accountAvatarSource = account ? canonicalAvatarImageSource(account.avatar) : null;
  const profileAdoptionSignature = JSON.stringify({
    accountId: account?.accountId ?? null,
    displayName:
      account?.displayName ?? account?.primaryEmail ?? null,
    avatarSeed: account?.avatar.seed ?? null,
    avatarSource: accountAvatarSource,
    profileHumanIdentityId:
      canonicalState?.profile.humanIdentityId ?? null,
  });

  useEffect(() => {
    if (
      !account
      || !canonicalStateReady
      || !setCanonicalState
    ) return;
    void profileIdentityAdoptionCoordinator.request(
      {
        accountId: account.accountId,
        displayName:
          account.displayName
          || account.primaryEmail
          || account.accountId,
        avatarKey: account.avatar.seed,
        profileImageUrl: canonicalAvatarImageSource(account.avatar),
      },
      adoptCloudProfileIdentity,
      (delta) => {
        setCanonicalState((current) =>
          applyCanonicalProfileIdentityDelta(current, delta)
        );
      },
    )
      .catch((error) => {
        reportWarning(
          '[cloud-profile-identity] failed to adopt stable cloud profile identity',
          error,
        );
      });
  }, [
    account,
    canonicalState?.profile.humanIdentityId,
    canonicalStateReady,
    profileAdoptionSignature,
    profileIdentityAdoptionCoordinator,
    reportWarning,
    setCanonicalState,
  ]);

  const contactIdentitySignature = useMemo(() => JSON.stringify({
    accountId: account?.accountId ?? null,
    localHumanIdentityId,
    contacts: contacts
      .map((contact) => ({
        id: contact.id,
        name: contact.name,
        sourceParticipantId:
          contact.sourceParticipantId ?? null,
        sourceHumanId: contact.sourceHumanId ?? null,
        profileImageUrl: contact.profileImageUrl ?? null,
        avatarSeed: contact.avatarSeed ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }), [account?.accountId, contacts, localHumanIdentityId]);

  useEffect(() => {
    if (!account || !localHumanIdentityId || !setCanonicalState) {
      syncedContactIdentitySignatureRef.current = null;
      return;
    }
    if (
      syncedContactIdentitySignatureRef.current
      === contactIdentitySignature
    ) return;
    syncedContactIdentitySignatureRef.current =
      contactIdentitySignature;
    let cancelled = false;
    void (async () => {
      for (const request of cloudContactsToCanonicalIdentityRequests({
        account,
        contacts,
        localHumanIdentityId,
      })) {
        if (cancelled) return;
        const identity = await upsertCanonicalIdentityFast(request);
        if (!cancelled) {
          setCanonicalState((current) =>
            upsertCanonicalIdentityIntoLocalState(current, identity)
          );
        }
      }
    })().catch(() => {
      syncedContactIdentitySignatureRef.current = null;
    });
    return () => {
      cancelled = true;
    };
  }, [
    account,
    contactIdentitySignature,
    contacts,
    localHumanIdentityId,
    setCanonicalState,
  ]);
}
