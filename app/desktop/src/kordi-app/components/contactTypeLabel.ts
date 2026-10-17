import type { Contact } from '../types';

// Every ordinary person is a user, so only labels that carry information are shown.
const PLAIN_CONTACT_TYPES = new Set(['user', 'person']);

export function contactTypeLabel(contact: Pick<Contact, 'entityType'>): string | null {
  const label = contact.entityType?.trim() ?? '';
  return label && !PLAIN_CONTACT_TYPES.has(label.toLowerCase()) ? label : null;
}
