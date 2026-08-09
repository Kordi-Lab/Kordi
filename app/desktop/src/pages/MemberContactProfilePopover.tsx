import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, MessageCircle, UserPlus } from 'lucide-react';

import { isApprovedCollaborationContact } from '@/features/chat/chatCreateFlows';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { Contact, ConversationParticipant } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

function memberStableId(member: ConversationParticipant) {
  return member.humanId?.trim()
    || member.sourceIdentityId?.trim()
    || member.id.trim();
}

function contactStableId(contact: Contact) {
  return contact.sourceHumanId?.trim()
    || contact.sourceParticipantId?.trim()
    || (contact.id.startsWith('cloud:') ? contact.id.slice('cloud:'.length).trim() : '')
    || contact.id.trim();
}

export function contactForGroupMember(contacts: Contact[], member: ConversationParticipant) {
  const memberIds = new Set([
    member.id,
    memberStableId(member),
    member.humanId?.trim(),
    member.sourceIdentityId?.trim(),
    member.id.startsWith('human:') ? member.id.slice('human:'.length).trim() : '',
  ].filter(Boolean));
  return contacts.find((contact) => [
    contact.id,
    contactStableId(contact),
    contact.sourceParticipantId?.trim(),
    contact.sourceHumanId?.trim(),
    contact.id.startsWith('cloud:') ? contact.id.slice('cloud:'.length).trim() : '',
  ].some((identityId) => Boolean(identityId && memberIds.has(identityId)))) ?? null;
}

export function groupMemberAccountId(member: ConversationParticipant, contact: Contact | null) {
  const candidates = [
    contact?.sourceParticipantId,
    contact?.sourceHumanId,
    member.humanId,
    member.sourceIdentityId,
    member.id.startsWith('human:') ? member.id.slice('human:'.length) : '',
  ];
  return candidates.map((value) => value?.trim() ?? '').find((value) => value.startsWith('acct_')) ?? '';
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
  const resolvedPresence = presenceStatus ?? contact?.presenceStatus ?? participant.presenceStatus ?? 'offline';
  const relationshipLabel = isSelf ? 'You' : isExistingContact ? 'Contact' : requestPending ? 'Request pending' : '';
  const profileDetail = readableContactDetail(contact, accountId);
  const identityDetail = profileDetail;

  useEffect(() => {
    setRequestState('idle');
    setIsOpeningMessage(false);
    setRequestError('');
  }, [participant.id]);

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
          <div className="app-transient-metadata mt-0.5 break-words">
            {[roleLabel, relationshipLabel].filter(Boolean).join(' · ')}
          </div>
          {identityDetail ? (
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

      {requestError ? (
        <p role="alert" className="app-transient-status mt-2 text-rose-500">{requestError}</p>
      ) : null}
    </div>
  );
}

type MemberContactProfilePopoverProps = MemberContactProfileContentProps & {
  anchorRect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  onClose: () => void;
};

export function MemberContactProfilePopover({
  anchorRect,
  onClose,
  ...contentProps
}: MemberContactProfilePopoverProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  const margin = 12;
  const gap = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(256, viewportWidth - margin * 2);
  const left = anchorRect.right + gap + width <= viewportWidth - margin
    ? anchorRect.right + gap
    : Math.max(margin, anchorRect.left - width - gap);
  const top = Math.min(
    Math.max(margin, anchorRect.top - 22),
    Math.max(margin, viewportHeight - 230 - margin),
  );

  return createPortal(
    <>
      <button
        type="button"
        className="fixed inset-0 z-[75] cursor-default bg-transparent"
        aria-label="Close member profile"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-label={`${contentProps.participant.name} profile`}
        className="app-transient-surface app-frosted-popover fixed z-[80] rounded-[16px] p-2.5 shadow-[var(--app-shadow-float)]"
        style={{ left, top, width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <MemberContactProfileContent {...contentProps} />
      </section>
    </>,
    document.body,
  );
}
