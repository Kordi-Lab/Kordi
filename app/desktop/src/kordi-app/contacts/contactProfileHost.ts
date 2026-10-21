import type { CloudContactProfile, CloudContactProfileAgent, CloudContactProfileGroup } from '@/features/cloud/contactProfileClient';
import { isAgentContact } from '../contactPresentation';
import type { Contact } from '../types';

export type ContactProfileKind = 'person' | 'agent' | 'own-agent' | 'system';

/**
 * What the contact pane needs from the hosting app to show the richer profile. Absent, or with
 * `accountIdFor` returning null, the pane keeps today's content.
 */
export type ContactProfileHost = {
  /** The account whose profile the server can serve for this contact, or null for none. */
  accountIdFor: (contact: Contact) => string | null;
  load: (accountId: string, signal: AbortSignal) => Promise<CloudContactProfile>;
  /** The Contacts row for an account, when it is in the list. */
  contactForAccount?: (accountId: string) => Contact | null;
  selectContact?: (contact: Contact) => void;
  /** Opens a chat with the person's agent; `person` is the contact whose profile is open. */
  openAgentChat?: (agent: CloudContactProfileAgent, person: Contact) => void;
  openGroup?: (group: CloudContactProfileGroup) => void;
};

/** Mute for the direct chat with a contact. `isMuted` returns null when the contact has no such chat. */
export type ContactMuteControl = {
  isMuted: (contact: Contact) => boolean | null;
  setMuted: (contact: Contact, muted: boolean) => Promise<void> | void;
};

export function contactProfileKind(contact: Contact, profile: CloudContactProfile | null): ContactProfileKind {
  if (contact.classType === 'my-agents') return 'own-agent';
  if (contact.systemContact || profile?.kind === 'system') return 'system';
  if (isAgentContact(contact) || profile?.kind === 'agent') return 'agent';
  return 'person';
}

const CONTACT_SINCE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "12 Aug 2026", or null for a missing or unreadable timestamp. */
export function formatContactSince(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? CONTACT_SINCE_FORMAT.format(at) : null;
}
