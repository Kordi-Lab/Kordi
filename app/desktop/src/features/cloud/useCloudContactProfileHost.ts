import { useEffect, useMemo, useRef } from 'react';

import type { Contact, ContactClass } from '@/kordi-app/types';
import type { ContactProfileHost } from '@/kordi-app/contacts/contactProfileHost';
import { cloudApiBaseUrl, defaultCloudAuthClient, type CloudAccount } from './authClient';
import { useCloudAuthCapabilitiesState } from './cloudAuthCapabilities';
import { CLOUD_HOST_SENTINEL } from './cloudContactMapping';
import { contactProfileVersionFromCapabilities, fetchContactProfile } from './contactProfileClient';
import { dispatchCloudGroupInvitationAccepted } from './groupInvitationDeepLink';

type ContactProfileHostOptions = {
  account: CloudAccount;
  contacts: Contact[];
  onMessageContact?: (contact: Contact) => void;
  onSelectContact: (groupId: ContactClass, contactId: string) => void;
};

/** The account a hosted contact row stands for. */
export function cloudContactAccountId(contact: Contact | undefined): string | null {
  if (!contact) return null;
  return (contact.sourceHumanId || contact.sourceParticipantId || (contact.id.startsWith('cloud:') ? contact.id.slice('cloud:'.length) : '')).trim() || null;
}

function contactForAccount(contacts: Contact[], accountId: string): Contact | null {
  return contacts.find((contact) => cloudContactAccountId(contact) === accountId) ?? null;
}

/**
 * Profile access for the Contacts pane, present only when the server reports
 * `contactProfileVersion`. Self and local (non-hosted) contacts keep today's pane.
 */
export function useCloudContactProfileHost(options: ContactProfileHostOptions): ContactProfileHost | undefined {
  const authClient = useMemo(() => defaultCloudAuthClient(), []);
  const { capabilities } = useCloudAuthCapabilitiesState(authClient, cloudApiBaseUrl());
  const available = contactProfileVersionFromCapabilities(capabilities) !== null;
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const selfAccountId = options.account.accountId;

  return useMemo<ContactProfileHost | undefined>(() => {
    if (!available) return undefined;
    return {
      accountIdFor: (contact) => {
        if (contact.sourceHostId !== CLOUD_HOST_SENTINEL || contact.classType === 'my-agents') return null;
        const accountId = cloudContactAccountId(contact);
        return accountId && accountId !== selfAccountId ? accountId : null;
      },
      load: (accountId, signal) => fetchContactProfile(accountId, {
        signal,
        request: (path, init, fallback) => authClient.request(path, init, fallback),
      }),
      contactForAccount: (accountId) => contactForAccount(latest.current.contacts, accountId),
      selectContact: (contact) => latest.current.onSelectContact(contact.classType, contact.id),
      openAgentChat: (agent, person) => {
        // A person's agent answers in the direct chat with that person unless the agent is a contact itself.
        const agentContact = agent.accountId ? contactForAccount(latest.current.contacts, agent.accountId) : null;
        latest.current.onMessageContact?.(agentContact ?? person);
      },
      openGroup: (group) => {
        dispatchCloudGroupInvitationAccepted({ groupId: group.groupId, groupSpaceId: group.groupId, groupTitle: group.title });
      },
    };
  }, [authClient, available, selfAccountId]);
}
