import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cloudApiBaseUrl, defaultCloudAuthClient, type CloudAccount } from '@/features/cloud/authClient';
import { useCloudAuthCapabilitiesState } from '@/features/cloud/cloudAuthCapabilities';
import { CloudConnectorsHttpClient } from '@/features/cloud/cloudConnectorsClient';
import { commonGroundVersionFromCapabilities } from '@/features/cloud/commonGroundCapability';
import { dispatchCloudGroupInvitationAccepted } from '@/features/cloud/groupInvitationDeepLink';
import { normalizeKordiId } from '@/features/cloud/kordiId';
import { memoryCardsSupported, memoryRoutingAvailable, memoryVersionFromCapabilities } from '@/features/cloud/memoryCapability';
import { cloudContactToContact, type UseCloudContactsResult } from '@/features/cloud/useCloudContacts';
import { connectorsClientForAccount } from '@/features/connectors/connectorsClientSelection';
import { CONNECTORS_SETTINGS_LINK_EVENT, type ConnectorsSettingsTarget } from '@/features/connectors/connectorsSettingsLink';
import { openDesktopExternalUrl } from '@/lib/desktop';
import type { Contact, ContactClass, ContactRequest } from '@/kordi-app/types';
import { CommonGroundContactsRow } from './CommonGroundContactsRow';
import { CommonGroundLazyPanel } from './CommonGroundLazyPanel';
import { desktopAgentFiles, desktopDeviceAccess } from './deviceAccess';
import { COMMON_GROUND_PAIR_LINK_EVENT, hasPendingPairLink } from './pairLink';
import type { CgConnectorsAccess, CgHost } from './host';
import type { CgPerson } from './types';

type ContactsSelectionHandlers = {
  onSelectContact: (groupId: ContactClass, contactId: string) => void;
  onSelectRequest?: (request: ContactRequest) => void;
  onCloseOverlay: () => void;
};

export type CommonGroundEntry = ContactsSelectionHandlers & {
  leadingListItems?: ReactNode;
  leadingDetail?: ReactNode;
};

export type CommonGroundEntryOptions = {
  account: CloudAccount | null;
  /** The Contacts "Message" path; receives a contact for the person. */
  onMessageContact?: (contact: Contact) => void;
  cloud: Pick<UseCloudContactsResult, 'contacts' | 'acceptRequest' | 'refresh'>;
};

/** The Contacts row for a person, or a fresh cloud contact when they are not one yet. */
function contactForPerson(contacts: Contact[], person: CgPerson): Contact {
  return contacts.find((contact) => !contact.systemContact && (contact.sourceHumanId || contact.sourceParticipantId) === person.accountId)
    ?? cloudContactToContact({ accountId: person.accountId, displayName: person.name, avatarUrl: person.avatarUrl, nodeId: null, createdAt: '' });
}

/** Opens account settings on the Connectors tab, as a Connectors link in a message does. */
function openConnectorsSettings(providerId: ConnectorsSettingsTarget['providerId']) {
  window.dispatchEvent(new CustomEvent<ConnectorsSettingsTarget>(CONNECTORS_SETTINGS_LINK_EVENT, { detail: { tab: 'connectors', providerId } }));
}

/**
 * The pinned Common ground row and its page in Contacts, shown for a signed-in account when the
 * server reports `commonGroundVersion`.
 */
export function useCommonGroundEntry(handlers: ContactsSelectionHandlers, options: CommonGroundEntryOptions): CommonGroundEntry {
  // A pairing link opens Grounding, which redeems the code.
  const [selected, setSelected] = useState(hasPendingPairLink);
  useEffect(() => {
    const onPairLink = () => setSelected(true);
    window.addEventListener(COMMON_GROUND_PAIR_LINK_EVENT, onPairLink);
    return () => window.removeEventListener(COMMON_GROUND_PAIR_LINK_EVENT, onPairLink);
  }, []);
  const authClient = useMemo(() => defaultCloudAuthClient(), []);
  const { capabilities, status: capabilitiesStatus } = useCloudAuthCapabilitiesState(options.account ? authClient : null, cloudApiBaseUrl());
  const version = commonGroundVersionFromCapabilities(capabilities);
  const available = Boolean(options.account) && version !== null;
  const profiles = (version ?? 0) >= 2;
  const sources = (version ?? 0) >= 3;
  const accountId = options.account?.accountId ?? '';
  // The host stays stable across renders; its callbacks read the latest options.
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const displayName = options.account?.displayName;
  const avatarUrl = options.account?.avatarUrl ?? null;
  const handle = normalizeKordiId(options.account?.kordiId);
  const memoryAvailable = memoryVersionFromCapabilities(capabilities) !== null;
  const memoryRouting = memoryRoutingAvailable(capabilities);
  const memoryCards = memoryCardsSupported(capabilities);
  const defaultAgentName = options.account?.defaultAgent?.displayName ?? undefined;
  // The same client the Connectors settings use; rows show only when the server serves them.
  const connectors = useMemo<CgConnectorsAccess | null>(() => {
    if (!accountId) return null;
    const selection = connectorsClientForAccount({
      accountId,
      http: new CloudConnectorsHttpClient(),
      capabilities,
      capabilitiesStatus,
      defaultAgentName,
    });
    if (!selection || selection.servicesStatus !== 'ready') return null;
    return { client: selection.client, openSettings: openConnectorsSettings };
  }, [accountId, capabilities, capabilitiesStatus, defaultAgentName]);

  const host = useMemo<CgHost>(() => ({
    self: { accountId, name: displayName || 'You', avatarUrl, handle },
    profiles,
    sources,
    memoryAvailable,
    memoryRouting,
    memoryCards,
    openChat: (person) => {
      setSelected(false);
      latest.current.onMessageContact?.(contactForPerson(latest.current.cloud.contacts, person));
    },
    acceptRequest: (requestId) => latest.current.cloud.acceptRequest(requestId),
    contactsChanged: () => { void latest.current.cloud.refresh().catch(() => undefined); },
    openGroup: (groupSpaceId) => {
      setSelected(false);
      dispatchCloudGroupInvitationAccepted({ groupId: groupSpaceId, groupSpaceId, groupTitle: '' });
    },
    connectors,
    agentFiles: desktopAgentFiles(),
    device: desktopDeviceAccess(),
    openUrl: (url) => { void openDesktopExternalUrl(url); },
  }), [accountId, displayName, avatarUrl, handle, profiles, sources, memoryAvailable, memoryRouting, memoryCards, connectors]);

  if (!available) return handlers;
  const { onSelectRequest } = handlers;
  return {
    onSelectContact: (groupId, contactId) => {
      setSelected(false);
      handlers.onSelectContact(groupId, contactId);
    },
    onSelectRequest: onSelectRequest ? (request) => {
      setSelected(false);
      onSelectRequest(request);
    } : undefined,
    onCloseOverlay: () => {
      setSelected(false);
      handlers.onCloseOverlay();
    },
    leadingListItems: <CommonGroundContactsRow selected={selected} onSelect={() => setSelected(true)} />,
    leadingDetail: selected ? <CommonGroundLazyPanel host={host} /> : null,
  };
}
