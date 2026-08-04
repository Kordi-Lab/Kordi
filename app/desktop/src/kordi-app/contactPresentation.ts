import { isCollaborationSelfContactId } from '@/features/collaboration/legacyBridgeCompatibility';

import type { Contact } from './types';

function normalizedContactText(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase();
}

export function contactPresenceStatus(contact: Contact): string | null {
  const directPresence = contact.presenceStatus?.trim().toLowerCase();
  if (directPresence === 'online') return 'online';
  if (directPresence) return 'offline';
  return null;
}

export function contactDetailBodyText(contact: Contact): string {
  const detail = contact.detail.trim();
  if (!detail) return '';
  const visibleIdentifiers = new Set([
    normalizedContactText(contact.name),
    normalizedContactText(contact.subtitle),
    normalizedContactText(contact.sourceParticipantId),
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
