import { useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { CanonicalSessionState, Contact } from '@/kordi-app/types';

import type { CloudAccount } from './authClient';
import { cloudGroupParticipantContacts } from './cloudCollaborationState';
import {
  cloudAccountGenerationKey,
  cloudBootstrapPeerIds,
  cloudMessagesAuthoritativeForContext,
  cloudUnreadReadinessContextKey,
  cloudUnreadStatusForContext,
  type CloudUnreadReadinessSnapshot,
  type CloudUnreadReadinessStatus,
} from './cloudMessageSyncState';
import type {
  CloudProfileIdentityAdoptionCoordinator,
  CloudSyncCoordinator,
} from './cloudSyncCoordinator';
import { useCloudCanonicalIdentitySync } from './useCloudCanonicalIdentitySync';
import { useCloudContacts } from './useCloudContacts';

type CloudCollaborationTopology = {
  bootstrapPeerIds: string[];
  bootstrapPeerKey: string;
  cloudContacts: Contact[];
  cloudLookupContacts: Contact[];
  accountContextKey: string | null;
  unreadContextKey: string | null;
  unreadReadinessStatus: CloudUnreadReadinessStatus;
  authoritativeMessagesReady: boolean;
  initialContactsSettled: boolean;
  initialMessagesSettled: boolean;
  refreshContacts: () => Promise<void>;
};

function cloudContactPeerIds(contacts: Contact[]): string[] {
  return contacts
    .map((contact) => (
      contact.sourceParticipantId
      || contact.id.replace(/^cloud:/, '')
    ))
    .filter((value): value is string => Boolean(value));
}

export function useCloudCollaborationTopology({
  account,
  canonicalState,
  setCanonicalState,
  syncCoordinator,
  profileIdentityAdoptionCoordinator,
  unreadReadiness,
  publishedUnreadContextKey,
  reportWarning,
}: {
  account: CloudAccount | null;
  canonicalState?: CanonicalSessionState | null;
  setCanonicalState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  syncCoordinator: CloudSyncCoordinator;
  profileIdentityAdoptionCoordinator:
    CloudProfileIdentityAdoptionCoordinator;
  unreadReadiness: CloudUnreadReadinessSnapshot;
  publishedUnreadContextKey: string | null;
  reportWarning: (message: string, error: unknown) => void;
}): CloudCollaborationTopology {
  const contacts = useCloudContacts(account);
  const acceptedContactPeerIds = useMemo(
    () => cloudContactPeerIds(contacts.contacts),
    [contacts.contacts],
  );
  const groupParticipantContacts = useMemo(
    () => account
      ? cloudGroupParticipantContacts({
        account,
        canonicalSessionState: canonicalState,
        existingPeerIds: acceptedContactPeerIds,
      })
      : [],
    [account, acceptedContactPeerIds, canonicalState],
  );
  const groupParticipantPeerIds = useMemo(
    () => cloudContactPeerIds(groupParticipantContacts),
    [groupParticipantContacts],
  );
  const cloudLookupContacts = useMemo(
    () => [...contacts.contacts, ...groupParticipantContacts],
    [contacts.contacts, groupParticipantContacts],
  );
  const bootstrapPeerIds = useMemo(
    () => cloudBootstrapPeerIds(
      account,
      acceptedContactPeerIds,
      groupParticipantPeerIds,
      contacts.requests,
    ),
    [
      account,
      acceptedContactPeerIds,
      contacts.requests,
      groupParticipantPeerIds,
    ],
  );
  const bootstrapPeerKey = useMemo(
    () => bootstrapPeerIds.join('|'),
    [bootstrapPeerIds],
  );
  const generation = syncCoordinator.currentGeneration();
  const unreadContextKey = account
    ? cloudUnreadReadinessContextKey(
      account.accountId,
      generation,
      bootstrapPeerKey,
    )
    : null;
  const accountContextKey = account
    ? cloudAccountGenerationKey(account.accountId, generation)
    : null;
  const authoritativeMessagesReady =
    cloudMessagesAuthoritativeForContext({
      accountId: account?.accountId,
      contactsSettled: contacts.initialLoadSettled,
      generation,
      peerKey: bootstrapPeerKey,
      readiness: unreadReadiness,
    });
  const unreadReadinessStatus = cloudUnreadStatusForContext({
    accountId: account?.accountId,
    contactsSettled: contacts.initialLoadSettled,
    generation,
    peerKey: bootstrapPeerKey,
    readiness: unreadReadiness,
    publishedContextKey: publishedUnreadContextKey,
  });

  useCloudCanonicalIdentitySync({
    account,
    contacts: contacts.contacts,
    canonicalState,
    setCanonicalState,
    profileIdentityAdoptionCoordinator,
    reportWarning,
  });

  return {
    bootstrapPeerIds,
    bootstrapPeerKey,
    cloudContacts: contacts.contacts,
    cloudLookupContacts,
    accountContextKey,
    unreadContextKey,
    unreadReadinessStatus,
    authoritativeMessagesReady,
    initialContactsSettled: contacts.initialLoadSettled,
    initialMessagesSettled: unreadReadinessStatus === 'ready',
    refreshContacts: () => contacts.refresh(),
  };
}
