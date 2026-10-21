import { useMemo, type ReactNode } from 'react';

import { ContactDetailBody } from '@/kordi-app/contacts/ContactDetailPane';
import type { Contact, Conversation } from '@/kordi-app/types';
import type { CloudAccount } from './authClient';
import { cloudContactToContact } from './cloudContactMapping';
import { cloudContactAccountId, useCloudContactProfileHost } from './useCloudContactProfileHost';
import { useCloudContacts } from './useCloudContacts';
import { useCloudPresence } from './useCloudPresence';

type CloudChatPersonInfoProps = {
  account: CloudAccount;
  conversation: Conversation;
  peerAccountId: string;
  /** Whether this chat is muted; null when the chat list has no mute for it. */
  muted: boolean | null;
  onSetMuted?: (muted: boolean) => Promise<void> | void;
  /** Leaves the detail page for the transcript; Photos, Links and Documents land there for now. */
  onReturnToChat: () => void;
  /** Today's Info content, shown while the server has no contact profile route. */
  legacy: ReactNode;
};

/** Info tab of a direct person chat: the contact profile without a Message tile. */
export function CloudChatPersonInfo({ account, conversation, peerAccountId, muted, onSetMuted, onReturnToChat, legacy }: CloudChatPersonInfoProps) {
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
  const isContact = cloud.contacts.some((item) => !item.systemContact && cloudContactAccountId(item) === peerAccountId);
  const { host, removeContact } = useCloudContactProfileHost({
    account,
    contacts: cloud.contacts,
    onMessageContact: () => onReturnToChat(),
    onSelectContact: () => undefined,
    onCloseOverlay: onReturnToChat,
    refreshContacts: () => cloud.refresh(),
  });
  if (!host) return <>{legacy}</>;
  return (
    <div className="app-contacts-page app-chat-person-info relative mx-auto w-full max-w-[420px] px-6 pb-10 pt-8">
      <div className="app-contacts-detail-content relative">
        <ContactDetailBody
          key={peerAccountId}
          contact={contact}
          showMessageTile={false}
          onCloseOverlay={() => undefined}
          onMessageContact={() => onReturnToChat()}
          onRemoveContact={isContact ? removeContact : undefined}
          contactProfileHost={host}
          contactMute={{
            isMuted: () => muted,
            setMuted: (_contact, next) => onSetMuted?.(next),
          }}
        />
      </div>
    </div>
  );
}
