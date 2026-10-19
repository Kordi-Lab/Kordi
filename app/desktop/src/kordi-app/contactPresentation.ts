import { formatKordiHandle } from '@/features/cloud/kordiId';
import { isCollaborationSelfContactId } from '@/features/collaboration/legacyBridgeCompatibility';

import { formatPresenceLine } from './contactPresenceLine';
import type { Contact, ContactRequest } from './types';

function normalizedContactText(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase();
}

export function contactPresenceStatus(contact: Contact): string | null {
  const directPresence = contact.presenceStatus?.trim().toLowerCase();
  if (directPresence === 'online') return 'online';
  if (directPresence) return 'offline';
  return null;
}

export function isAgentContact(contact: Pick<Contact, 'classType'>) {
  return contact.classType === 'my-agents' || contact.classType === 'other-users-agents';
}

export type ContactSecondaryLine = { text: string; online: boolean };

/**
 * Second line under a contact's name. People show presence ("online", "last seen 9 minutes ago");
 * agents and Kordi's own contacts keep their description, and unknown presence falls back to it.
 */
export function contactSecondaryLine(
  contact: Pick<Contact, 'classType' | 'systemContact' | 'subtitle' | 'presenceStatus' | 'presenceLastSeenAt'>,
  now: Date | number = Date.now(),
): ContactSecondaryLine {
  const subtitle = contact.subtitle.trim();
  if (isAgentContact(contact) || contact.systemContact) return { text: subtitle, online: false };
  const presence = formatPresenceLine(contact.presenceStatus, contact.presenceLastSeenAt, now);
  return presence ? { text: presence, online: presence === 'online' } : { text: subtitle, online: false };
}

/** Public `@123456789` handle carried in a contact's detail or subtitle, when it has one. */
export function contactKordiHandle(contact: Pick<Contact, 'detail' | 'subtitle'>): string | null {
  return formatKordiHandle(contact.detail) || formatKordiHandle(contact.subtitle);
}

export function contactDetailBodyText(contact: Contact): string {
  const detail = contact.detail.trim();
  if (!detail) return '';
  const visibleIdentifiers = new Set([
    normalizedContactText(contact.name),
    normalizedContactText(contact.subtitle),
    normalizedContactText(contact.sourceParticipantId),
    normalizedContactText(contactKordiHandle(contact)),
  ].filter(Boolean));
  return visibleIdentifiers.has(normalizedContactText(detail)) ? '' : detail;
}

export function contactCanBeRemoved(contact: Contact): boolean {
  return Boolean(
    contact.sourceHostId
      && contact.sourceParticipantId
      && !isCollaborationSelfContactId(contact.id)
      && contact.classType !== 'my-agents'
      && !contact.locked
      && !contact.systemContact,
  );
}

/** The other person's name, without the "wants to connect" / "Request sent to" phrasing of the title. */
export function contactRequestDisplayName(request: Pick<ContactRequest, 'avatarName' | 'title'>) {
  const avatarName = request.avatarName?.trim();
  if (avatarName) return avatarName;
  const title = request.title.trim();
  return title.replace(/^Request sent to\s+/i, '').replace(/\s+wants to connect$/i, '').trim() || title;
}

export function isOutgoingContactRequest(request: Pick<ContactRequest, 'direction'>) {
  return request.direction?.trim().toLowerCase() === 'outgoing';
}

/** Second line of a request row: the public handle when known, otherwise the request state. */
export function contactRequestSummary(request: Pick<ContactRequest, 'detail' | 'direction'>) {
  return formatKordiHandle(request.detail) || (isOutgoingContactRequest(request) ? 'Awaiting approval' : 'Wants to connect');
}
