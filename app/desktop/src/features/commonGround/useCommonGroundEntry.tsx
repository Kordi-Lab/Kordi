import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cloudApiBaseUrl, defaultCloudAuthClient, type CloudAccount } from '@/features/cloud/authClient';
import { useCloudAuthCapabilitiesState } from '@/features/cloud/cloudAuthCapabilities';
import { CloudConnectorsHttpClient } from '@/features/cloud/cloudConnectorsClient';
import { commonGroundVersionFromCapabilities } from '@/features/cloud/commonGroundCapability';
import { dispatchCloudGroupInvitationAccepted } from '@/features/cloud/groupInvitationDeepLink';
import { memoryVersionFromCapabilities } from '@/features/cloud/memoryCapability';
import { loadSession } from '@/features/cloud/session';
import { cloudContactToContact, type UseCloudContactsResult } from '@/features/cloud/useCloudContacts';
import { connectorCatalog } from '@/features/connectors/connectorsModel';
import { openDesktopExternalUrl } from '@/lib/desktop';
import type { Contact, ContactClass, ContactRequest } from '@/kordi-app/types';
import { CommonGroundContactsRow } from './CommonGroundContactsRow';
import { CommonGroundLazyPanel } from './CommonGroundLazyPanel';
import { desktopDeviceAccess } from './deviceAccess';
import type { CgConnector, CgHost } from './host';
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

async function connectedConnectors(enabled: boolean): Promise<CgConnector[]> {
  if (!enabled) return [];
  const session = await loadSession();
  if (!session?.token) return [];
  const { connectors } = await new CloudConnectorsHttpClient().list(session.token);
  return connectors
    .filter((connector) => connector.status === 'connected')
    .map((connector) => ({
      id: connector.provider,
      name: connectorCatalog.find((definition) => definition.providerId === connector.provider)?.name ?? connector.provider,
    }));
}

/**
 * The pinned Common ground row and its page in Contacts, shown for a signed-in account when the
 * server reports `commonGroundVersion`.
 */
export function useCommonGroundEntry(handlers: ContactsSelectionHandlers, options: CommonGroundEntryOptions): CommonGroundEntry {
  const [selected, setSelected] = useState(false);
  const authClient = useMemo(() => defaultCloudAuthClient(), []);
  const { capabilities } = useCloudAuthCapabilitiesState(options.account ? authClient : null, cloudApiBaseUrl());
  const available = Boolean(options.account) && commonGroundVersionFromCapabilities(capabilities) !== null;
  const accountId = options.account?.accountId ?? '';
  // The host stays stable across renders; its callbacks read the latest options.
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const displayName = options.account?.displayName;
  const avatarUrl = options.account?.avatarUrl ?? null;
  const memoryAvailable = memoryVersionFromCapabilities(capabilities) !== null;
  const connectorsAvailable = typeof capabilities?.connectorsVersion === 'number';

  const host = useMemo<CgHost>(() => ({
    self: { accountId, name: displayName || 'You', avatarUrl },
    memoryAvailable,
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
    listConnectors: () => connectedConnectors(connectorsAvailable),
    device: desktopDeviceAccess(),
    openUrl: (url) => { void openDesktopExternalUrl(url); },
  }), [accountId, displayName, avatarUrl, memoryAvailable, connectorsAvailable]);

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
