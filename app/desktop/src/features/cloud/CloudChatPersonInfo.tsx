import { lazy, Suspense, useMemo, type ReactNode } from 'react';

import type { Contact, Conversation } from '@/kordi-app/types';
import type { ChatSenderProfileOpener } from '@/pages/useChatSenderProfiles';
import type { CloudAccount } from './authClient';
import { cloudContactToContact } from './cloudContactMapping';
import { directChatPeerParticipant } from './cloudDirectChatPeer';
import { cloudContactAccountId, useCloudContactProfileHost } from './useCloudContactProfileHost';
import { useCloudContacts } from './useCloudContacts';
import { useCloudPresence } from './useCloudPresence';

// Loaded with the first Info tab, outside the cloud chunk: the view and the shared pages come with it.
const ChatPersonInfo = lazy(() => import('@/kordi-app/contacts/ChatPersonInfo').then((module) => ({ default: module.ChatPersonInfo })));

type CloudChatPersonInfoProps = {
  account: CloudAccount;
  conversation: Conversation;
  peerAccountId: string;
  /** Leaves the detail page for the transcript; shared rows land there until the chat is fully loaded. */
  onReturnToChat: () => void;
  /** Today's Info content, shown while the server has no contact profile route. */
  legacy: ReactNode;
  /** Opens a participant's profile popover, as the chat header and transcript do. */
  openProfile?: ChatSenderProfileOpener | null;
};

/** Info tab of a direct person chat: participants and what the two accounts share. */
export function CloudChatPersonInfo({ account, conversation, peerAccountId, onReturnToChat, legacy, openProfile }: CloudChatPersonInfoProps) {
  const cloud = useCloudContacts(account);
  const presence = useCloudPresence(account);
  const contact = useMemo<Contact>(() => {
    const row = cloud.contacts.find((item) => !item.systemContact && cloudContactAccountId(item) === peerAccountId)
      ?? cloudContactToContact({ accountId: peerAccountId, displayName: conversation.name, avatarUrl: null, nodeId: null, createdAt: '' });
    return {
      ...row,
      presenceStatus: presence.statusForAccount(peerAccountId),
      presenceLastSeenAt: presence.snapshot[peerAccountId]?.lastSeenAt ?? null,
    };
  }, [cloud.contacts, conversation.name, peerAccountId, presence]);
  const { host } = useCloudContactProfileHost({
    account,
    contacts: cloud.contacts,
    onMessageContact: () => onReturnToChat(),
    onSelectContact: () => undefined,
    onCloseOverlay: onReturnToChat,
    refreshContacts: () => cloud.refresh(),
  });
  if (!host) return <>{legacy}</>;
  return (
    <Suspense fallback={null}>
      <ChatPersonInfo
        key={peerAccountId}
        peer={contact}
        self={{ id: account.accountId, name: account.displayName ?? '', imageUrl: account.avatarUrl }}
        conversation={conversation}
        host={host}
        onReturnToChat={onReturnToChat}
        onOpenPeer={openProfile
          ? (anchorRect) => openProfile(conversation, directChatPeerParticipant(conversation, peerAccountId, contact), anchorRect)
          : undefined}
      />
    </Suspense>
  );
}
