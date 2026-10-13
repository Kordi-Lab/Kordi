import { createContext, useContext } from 'react';

import { CLOUD_HOST_SENTINEL } from '@/features/cloud/cloudContactMapping';
import type { CloudAccount } from '@/features/cloud/cloudIdentityTypes';
import { revealDesktopAttachment } from '@/features/chat/attachmentDesktopActions';
import type { Contact, Conversation, Message, MessageAttachment } from '@/kordi-app/types';

export type DocumentReaderPerson = {
  accountId: string | null;
  displayName: string;
  kordiId?: string | null;
  avatarUrl?: string | null;
};

/** What the reader needs from the chat around it. Every action is optional; a missing one hides its control. */
export type DocumentReaderHost = {
  viewer: DocumentReaderPerson | null;
  sessionId: string | null;
  /** Agent of the session, offered in the comment `@` picker. */
  agentName: string | null;
  /** Other people in the session, offered in the comment `@` picker. */
  people: string[];
  /** Agents in the session for the `@` picker; `mine` are the viewer's own and come first. */
  agents?: { name: string; mine: boolean }[];
  canMessageAccount?: (accountId: string) => boolean;
  messageAccount?: (accountId: string) => void;
  sendAttachment?: (attachment: MessageAttachment) => void;
  revealPath?: (path: string) => Promise<unknown> | void;
  /** Set where a chat companion pane can host the reader (the chat Artifacts tab). */
  opensDocumentsInCompanion?: boolean;
};

const EMPTY_HOST: DocumentReaderHost = { viewer: null, sessionId: null, agentName: null, people: [] };

export const DocumentReaderHostContext = createContext<DocumentReaderHost>(EMPTY_HOST);

export function useDocumentReaderHost() {
  return useContext(DocumentReaderHostContext);
}

function cloudContactForAccount(contacts: Contact[], accountId: string) {
  return contacts.find((contact) => (
    contact.sourceHostId === CLOUD_HOST_SENTINEL && contact.sourceParticipantId?.trim() === accountId
  )) ?? null;
}

/** Builds the reader host for the active chat from the shell's contacts, forward flow, and account. */
export function documentReaderHostForConversation({
  account,
  conversation,
  contacts,
  isNativeShell,
  startChatWithPerson,
  forwardMessage,
}: {
  account: CloudAccount | null;
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'canonicalParticipants'>;
  contacts: Contact[];
  isNativeShell: boolean;
  startChatWithPerson?: (contact: Contact) => Promise<void> | void;
  forwardMessage?: (message: Message) => void;
}): DocumentReaderHost {
  const participants = conversation.canonicalParticipants ?? [];
  const agentName = participants.find((participant) => participant.kind === 'agent')?.name?.trim() || null;
  const accountId = account?.accountId ?? null;
  const selfIds = new Set(participants.filter((participant) => participant.role === 'self').map((participant) => participant.id));
  const agents = new Map<string, boolean>();
  for (const participant of participants) {
    const name = participant.kind === 'agent' ? participant.name.trim() : '';
    if (!name) continue;
    const ownerId = participant.ownerIdentityId?.trim() || null;
    const mine = participant.role === 'owned-agent' || Boolean(ownerId && (ownerId === accountId || selfIds.has(ownerId)));
    agents.set(name, agents.get(name) || mine);
  }
  const people = participants
    .filter((participant) => participant.kind !== 'agent' && participant.role !== 'self')
    .map((participant) => participant.name.trim())
    .filter(Boolean);
  const sessionId = conversation.canonicalSessionId ?? conversation.id;
  return {
    viewer: account
      ? { accountId: account.accountId, displayName: account.displayName?.trim() || 'You', kordiId: account.kordiId ?? null, avatarUrl: account.avatarUrl }
      : null,
    sessionId,
    agentName,
    people: [...new Set(people)],
    agents: [...agents].map(([name, mine]) => ({ name, mine })),
    canMessageAccount: startChatWithPerson ? (accountId) => Boolean(cloudContactForAccount(contacts, accountId)) : undefined,
    messageAccount: startChatWithPerson
      ? (accountId) => {
          const contact = cloudContactForAccount(contacts, accountId);
          if (contact) void startChatWithPerson(contact);
        }
      : undefined,
    // The forward flow takes a message; a document travels as an attachment-only message.
    sendAttachment: forwardMessage
      ? (attachment) => forwardMessage({
          id: `document:${attachment.attachmentId ?? attachment.name}`,
          role: 'user',
          isOwnMessage: true,
          text: '',
          time: '',
          attachments: [attachment],
        })
      : undefined,
    revealPath: isNativeShell ? (path) => revealDesktopAttachment(path) : undefined,
  };
}
