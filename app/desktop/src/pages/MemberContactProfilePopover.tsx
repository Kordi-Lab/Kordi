import { useMemo, useState } from 'react';
import { Ban, Check, Flag, LoaderCircle, MessageCircle, UserPlus } from 'lucide-react';

import { isApprovedCollaborationContact } from '@/features/chat/chatCreateFlows';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import { useSafetyActions } from '@/features/safety/safetyActions';
import { isServiceAccountId } from '@/features/safety/serviceAccounts';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { Contact, ConversationParticipant } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import {
  contactForGroupMember,
  groupMemberAccountId,
} from '@/pages/memberContactProfileModel';

function memberStableId(member: ConversationParticipant) {
  return member.humanId?.trim()
    || member.sourceIdentityId?.trim()
    || member.id.trim();
}

function readableContactDetail(contact: Contact | null, accountId: string) {
  if (!contact) return '';
  const opaqueValues = [
    accountId,
    contact.id,
    contact.sourceHumanId,
    contact.sourceParticipantId,
  ].map((value) => value?.trim().toLowerCase() ?? '').filter(Boolean);
  return [contact.detail, contact.subtitle]
    .map((value) => value?.trim() ?? '')
    .find((value) => {
      if (!value || value.length > 80) return false;
      const normalized = value.toLowerCase();
      if (['person', 'user'].includes(normalized)) return false;
      return !opaqueValues.some((opaque) => normalized === opaque || normalized.includes(opaque));
    }) ?? '';
}

type MemberContactProfileContentProps = {
  participant: ConversationParticipant;
  contacts: Contact[];
  roleLabel?: string;
  metadataMode?: 'relationship' | 'kordi-handle';
  presenceStatus?: string | null;
  isSelf?: boolean;
  onAddContact?: (accountId: string) => Promise<void> | void;
  onMessageContact?: (contact: Contact) => Promise<void> | void;
  className?: string;
};

export function MemberContactProfileContent({
  participant,
  contacts,
  roleLabel = 'Group member',
  metadataMode = 'relationship',
  presenceStatus,
  isSelf = false,
  onAddContact,
  onMessageContact,
  className,
}: MemberContactProfileContentProps) {
  const [requestState, setRequestState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [isOpeningMessage, setIsOpeningMessage] = useState(false);
  const [requestError, setRequestError] = useState('');
  const contact = useMemo(
    () => contactForGroupMember(contacts, participant),
    [contacts, participant],
  );
  const accountId = groupMemberAccountId(participant, contact);
  const contactStatus = contact?.contactStatus?.trim().toLowerCase() ?? '';
  const isExistingContact = Boolean(contact && isApprovedCollaborationContact(contact));
  const requestPending = contactStatus === 'pending' || requestState === 'sent';
  const canRequestContact = Boolean(onAddContact && accountId && !isSelf && !isExistingContact);
  const safety = useSafetyActions();
  // Other people only: Kordi service accounts cannot be blocked or reported here.
  const canUseSafetyActions = safety.safetyFeaturesAvailable && !isSelf && Boolean(accountId)
    && accountId !== safety.account?.accountId && !isServiceAccountId(accountId);
  const memberBlocked = safety.blockedAccountIds.has(accountId);
  const resolvedPresence = presenceStatus ?? contact?.presenceStatus ?? participant.presenceStatus ?? 'offline';
  const relationshipLabel = isSelf ? 'You' : isExistingContact ? 'Contact' : requestPending ? 'Request pending' : '';
  const profileDetail = readableContactDetail(contact, accountId);
  const identityDetail = profileDetail;
  const kordiHandle = formatKordiHandle(participant.kordiId)
    || formatKordiHandle(contact?.detail)
    || formatKordiHandle(contact?.subtitle);
  const secondaryLine = metadataMode === 'kordi-handle'
    ? kordiHandle
    : [roleLabel, relationshipLabel].filter(Boolean).join(' · ');

  const requestContact = async () => {
    if (!onAddContact || !accountId || requestState === 'sending' || requestPending) return;
    setRequestState('sending');
    setRequestError('');
    try {
      await onAddContact(accountId);
      setRequestState('sent');
    } catch (error) {
      setRequestState('error');
      setRequestError(error instanceof Error ? error.message : 'Could not send the contact request.');
    }
  };

  const openMessage = async () => {
    if (!onMessageContact || !contact || isOpeningMessage) return;
    setIsOpeningMessage(true);
    setRequestError('');
    try {
      await onMessageContact(contact);
    } catch (error) {
      setIsOpeningMessage(false);
      setRequestError(error instanceof Error ? error.message : 'Could not open the conversation.');
    }
  };

  return (
    <div className={cn('min-w-0', className)} data-member-contact-profile="true">
      <div className="flex min-w-0 items-center gap-2.5">
        <IdentityAvatar
          kind="human"
          seed={participant.avatarKey ?? memberStableId(participant)}
          isSelf={isSelf}
          name={participant.name}
          imageUrl={participant.profileImageUrl}
          className="h-9 w-9 border border-white/10"
          presenceStatus={resolvedPresence}
          presenceLabel={`${participant.name} is ${resolvedPresence === 'online' ? 'online' : 'offline'}`}
        />
        <div className="min-w-0 flex-1">
          <div className="app-transient-identity-title break-words">{participant.name}</div>
          {secondaryLine ? (
            <div className="app-transient-metadata mt-0.5 break-words" data-member-contact-secondary-line>
              {secondaryLine}
            </div>
          ) : null}
          {metadataMode === 'relationship' && identityDetail ? (
            <div
              className="app-transient-metadata mt-0.5 break-all"
              title={profileDetail ? identityDetail : accountId}
            >
              {identityDetail}
            </div>
          ) : null}
        </div>
        {isExistingContact && !isSelf && onMessageContact ? (
          <button
            type="button"
            data-member-contact-action="message"
            className="app-member-contact-icon-action app-transient-flat-action inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] p-0 transition"
            disabled={isOpeningMessage}
            onClick={() => { void openMessage(); }}
            aria-label={`${isOpeningMessage ? 'Opening conversation with' : 'Send message to'} ${participant.name}`}
            title={isOpeningMessage ? 'Opening…' : 'Send message'}
          >
            {isOpeningMessage
              ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              : <MessageCircle className="h-3.5 w-3.5" />}
            <span className="sr-only">{isOpeningMessage ? 'Opening…' : 'Send message'}</span>
          </button>
        ) : isExistingContact && !isSelf ? (
          <div className="app-transient-metadata flex shrink-0 items-center gap-1.5 px-1.5 py-1">
            <Check className="h-3 w-3" aria-hidden="true" />
            In contacts
          </div>
        ) : null}

        {canRequestContact ? (
          <button
            type="button"
            data-member-contact-action="add"
            className="app-transient-flat-action app-transient-action-row app-group-management-action-row inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-2 py-1 transition"
            disabled={requestState === 'sending' || requestPending}
            onClick={() => { void requestContact(); }}
          >
            {requestState === 'sending'
              ? <LoaderCircle className="app-transient-action-icon animate-spin motion-reduce:animate-none" />
              : <UserPlus className="app-transient-action-icon" />}
            <span className="app-transient-action-label">{requestState === 'sending' ? 'Sending…' : requestPending ? 'Request pending' : 'Add contact'}</span>
          </button>
        ) : null}
      </div>

      {canUseSafetyActions ? (
        <div className="mt-2 flex flex-wrap gap-1.5" data-member-contact-safety-actions>
          <button
            type="button"
            data-member-contact-action={memberBlocked ? 'unblock' : 'block'}
            className="app-transient-flat-action app-transient-action-row inline-flex min-h-7 items-center gap-1.5 rounded-[9px] px-2 py-1 transition"
            onClick={() => {
              if (memberBlocked) safety.openUnblock({ accountId, name: participant.name });
              else safety.openBlock({ accountId, name: participant.name });
            }}
          >
            <Ban className="app-transient-action-icon" aria-hidden="true" />
            <span className="app-transient-action-label">{memberBlocked ? 'Unblock…' : 'Block…'}</span>
          </button>
          <button
            type="button"
            data-member-contact-action="report"
            className="app-transient-flat-action app-transient-action-row inline-flex min-h-7 items-center gap-1.5 rounded-[9px] px-2 py-1 transition"
            onClick={() => safety.openReport({ accountId, name: participant.name })}
          >
            <Flag className="app-transient-action-icon" aria-hidden="true" />
            <span className="app-transient-action-label">Report…</span>
          </button>
        </div>
      ) : null}

      {requestError ? (
        <p role="alert" className="app-transient-status mt-2 text-rose-500">{requestError}</p>
      ) : null}
    </div>
  );
}
