import type { Contact, Conversation } from '@/kordi-app/types';

const EMPTY_CONTACT: Contact = {
  id: '', name: 'Select a contact', initials: '', classType: 'other-users',
  entityType: 'Contact', subtitle: '', collaborationSources: [], status: '',
  discoverableOn: [], detail: '', owner: '',
};

export function contactForWorkspaceSelection(contacts: Contact[], selectedId: string, fallback = EMPTY_CONTACT) {
  return contacts.find((contact) => contact.id === selectedId) ?? contacts[0] ?? fallback;
}

export function searchWorkspaceConversations(chatConversations: Conversation[], chatSearch: string) {
    const normalizedSearch = chatSearch.trim().toLowerCase();
    if (normalizedSearch.length === 0) return chatConversations;
    return chatConversations.filter((conversation) => (
      [conversation.name, conversation.subtitle, conversation.participants.join(' '), conversation.messages[conversation.messages.length - 1]?.text]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedSearch))
    ));
}
