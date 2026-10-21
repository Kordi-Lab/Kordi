import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import type { CloudContactProfile } from '@/features/cloud/contactProfileClient';
import { cn } from '@/lib/utils';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { contactKordiHandle, contactPresenceStatus, contactSecondaryLine } from '../contactPresentation';
import type { Contact, Conversation } from '../types';
import { SectionLabel, SharedWithYouCard, SharedWithYouLoading } from './ContactProfileCards';
import type { ContactProfileHost } from './contactProfileHost';
import { useContactProfile } from './useContactProfile';
import { useContactSharedPages } from './useContactSharedPages';
import { usePresenceNow } from './usePresenceNow';

export type ChatPersonInfoSelf = { id: string; name: string; imageUrl: string | null };

type ChatPersonInfoProps = {
  /** The other person in the direct chat. */
  peer: Contact;
  self: ChatPersonInfoSelf;
  conversation: Conversation;
  host?: ContactProfileHost;
  /** Opens the other person's profile popover next to their row. */
  onOpenPeer?: (anchorRect: DOMRect) => void;
  /** Leaves the Info tab for the transcript; shared rows land there until the whole chat is loaded. */
  onReturnToChat: () => void;
};

const NO_SHARED: CloudContactProfile['shared'] = { mediaCount: 0, linkCount: 0, documentCount: 0, groups: [] };
const AVATAR_CLASS = 'h-9 w-9 shrink-0';

function ParticipantRow({ avatar, name, line, online = false, onOpen }: {
  avatar: ReactNode;
  name: string;
  line: string;
  online?: boolean;
  onOpen?: (anchorRect: DOMRect) => void;
}) {
  const body = (
    <>
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="app-chat-person-info-name block truncate">{name}</span>
        {line ? (
          <span className={cn('app-chat-person-info-line block truncate', online && 'app-contacts-presence-online')}>{line}</span>
        ) : null}
      </span>
      {onOpen ? <ChevronRight className="app-contacts-chevron h-[15px] w-[15px] shrink-0" aria-hidden="true" /> : null}
    </>
  );
  const className = 'app-contacts-card-row app-chat-person-info-participant flex w-full items-center gap-3 text-left';
  return onOpen ? (
    <button
      type="button"
      className={cn(className, 'app-contacts-card-button')}
      aria-haspopup="dialog"
      onClick={(event) => onOpen(event.currentTarget.getBoundingClientRect())}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * Info tab of a direct person chat: who is in the chat and what the two accounts share. The
 * profile itself lives in the popover the other person's row opens.
 */
export function ChatPersonInfo({ peer, self, conversation, host, onOpenPeer, onReturnToChat }: ChatPersonInfoProps) {
  const now = usePresenceNow();
  const state = useContactProfile(peer, host);
  const shared = useContactSharedPages(peer, () => conversation, { backLabel: 'Back' });
  if (shared.page) return <div className="app-contacts-page app-chat-person-info is-page">{shared.page}</div>;

  const presence = state.profile?.presence;
  const contact = presence ? { ...peer, presenceStatus: presence.status, presenceLastSeenAt: presence.lastSeenAt } : peer;
  const status = contactPresenceStatus(contact);
  const secondary = contactSecondaryLine(contact, now);
  const line = secondary.text && secondary.text !== contactKordiHandle(contact) && secondary.text !== contact.name ? secondary.text : '';
  const selfName = self.name.trim() || 'You';
  const profile = state.profile;

  return (
    <div className="app-contacts-page app-chat-person-info">
      <SectionLabel>Participants</SectionLabel>
      <div className="app-contacts-card rounded-[12px]">
        <ParticipantRow
          avatar={(
            <IdentityAvatar
              kind="human"
              seed={contact.avatarSeed ?? contact.sourceParticipantId ?? contact.id}
              name={contact.name}
              imageUrl={contact.profileImageUrl}
              presenceStatus={status}
              presenceLabel={status ? `${contact.name} is ${status}` : undefined}
              cornerRadius="50%"
              className={AVATAR_CLASS}
            />
          )}
          name={contact.name}
          line={line}
          online={secondary.online && line === secondary.text}
          onOpen={onOpenPeer}
        />
        <ParticipantRow
          avatar={<IdentityAvatar kind="human" seed={self.id} isSelf name={selfName} imageUrl={self.imageUrl} cornerRadius="50%" className={AVATAR_CLASS} />}
          name={selfName}
          line={selfName === 'You' ? '' : 'You'}
        />
      </div>
      {profile || shared.counts ? (
        <SharedWithYouCard
          shared={profile?.shared ?? NO_SHARED}
          local={shared.counts}
          onOpenPage={shared.open}
          onOpenChat={onReturnToChat}
          onOpenGroup={host?.openGroup}
        />
      ) : state.status === 'loading' ? <SharedWithYouLoading /> : null}
    </div>
  );
}
