import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Copy,
  LoaderCircle,
  MessageCircle,
  Phone,
  UserPlus,
  Video,
  X,
} from 'lucide-react';

import { isApprovedCollaborationContact } from '@/features/chat/chatCreateFlows';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import type { CloudPresenceAccount } from '@/features/cloud/presence';
import { useCloudCallContext } from '@/features/cloud/useCloudCallContext';
import { useContactPresenceLabel } from '@/features/cloud/useCloudPresence';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { ContactProfileSharedContent } from '@/pages/ContactProfileSharedContent';
import type {
  Contact,
  Conversation,
  ConversationParticipant,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';
import {
  contactForGroupMember,
  contactProfileGeometry,
  contactProfileSharedSummary,
  directCallConversationForMember,
  groupMemberAccountId,
  type ContactProfileAnchorRect,
} from '@/pages/memberContactProfileModel';

type ContactInfoPopoverProps = {
  participant: ConversationParticipant;
  contacts: Contact[];
  presence?: CloudPresenceAccount | null;
  presenceStatus?: string | null;
  onAddContact?: (accountId: string) => Promise<void> | void;
  onMessageContact?: (contact: Contact) => Promise<void> | void;
  anchorRect: ContactProfileAnchorRect;
  conversation?: Conversation | null;
  commonGroups?: ParticipantSpaceViewModel[];
  onOpenCommonGroup?: (space: ParticipantSpaceViewModel) => void;
  onClose: () => void;
};

const PROFILE_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function memberStableId(member: ConversationParticipant) {
  return member.humanId?.trim()
    || member.sourceIdentityId?.trim()
    || member.id.trim();
}

function sentenceCase(value: string) {
  return value ? value[0].toLocaleUpperCase() + value.slice(1) : value;
}

function ProfileAction({
  icon,
  label,
  onClick,
  disabled = false,
  title,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="app-contact-profile-action app-transient-flat-action flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-[13px] px-2 py-2.5 text-center"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      {icon}
      <span className="truncate text-[10.5px] font-medium">{label}</span>
    </button>
  );
}

export function ContactInfoPopover({
  anchorRect,
  conversation,
  commonGroups = [],
  onClose,
  participant,
  contacts,
  presence,
  presenceStatus,
  onAddContact,
  onMessageContact,
  onOpenCommonGroup,
}: ContactInfoPopoverProps) {
  const calls = useCloudCallContext();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [requestState, setRequestState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [messageState, setMessageState] = useState<'idle' | 'opening' | 'error'>('idle');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [viewport, setViewport] = useState(() => (
    typeof window === 'undefined'
      ? null
      : { width: window.innerWidth, height: window.innerHeight }
  ));
  const contact = useMemo(
    () => contactForGroupMember(contacts, participant),
    [contacts, participant],
  );
  const accountId = groupMemberAccountId(participant, contact);
  const directCallConversation = useMemo(() => {
    if (!calls?.account) return null;
    if (conversation) {
      const existingTarget = calls.targetForConversation(conversation);
      if (existingTarget?.kind === 'direct' && existingTarget.peerAccountId === accountId) {
        return conversation;
      }
    }
    return directCallConversationForMember(calls.account, participant, contact);
  }, [accountId, calls, contact, conversation, participant]);
  const callTarget = directCallConversation
    ? calls?.targetForConversation(directCallConversation) ?? null
    : null;
  const activeCall = directCallConversation
    ? calls?.callForConversation(directCallConversation) ?? null
    : null;
  const callIsCurrent = Boolean(activeCall && calls?.currentCall?.call.id === activeCall.id);
  const callBusyElsewhere = Boolean(calls?.currentCall && !callIsCurrent);
  const isExistingContact = Boolean(contact && isApprovedCollaborationContact(contact));
  const contactStatus = contact?.contactStatus?.trim().toLowerCase() ?? '';
  const requestPending = contactStatus === 'pending' || requestState === 'sent';
  const canAddContact = Boolean(onAddContact && accountId && !isExistingContact && !requestPending);
  const canMessage = Boolean(onMessageContact && contact && isExistingContact);
  const resolvedPresence = presence?.status
    ?? presenceStatus
    ?? contact?.presenceStatus
    ?? participant.presenceStatus
    ?? 'offline';
  const livePresenceLabel = useContactPresenceLabel(presence);
  const resolvedPresenceLabel = livePresenceLabel
    ?? (resolvedPresence === 'online' ? 'online' : 'last seen recently');
  const handle = formatKordiHandle(participant.kordiId)
    || formatKordiHandle(contact?.detail)
    || formatKordiHandle(contact?.subtitle);
  const summary = useMemo(
    () => contactProfileSharedSummary(conversation, commonGroups.length),
    [commonGroups.length, conversation],
  );
  const { style, placement } = viewport
    ? contactProfileGeometry(anchorRect, viewport)
    : contactProfileGeometry(anchorRect);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(PROFILE_FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.addEventListener('keydown', onKeyDown, true);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const previous = previouslyFocusedRef.current;
      queueMicrotask(() => previous?.focus());
    };
  }, [onClose]);

  useEffect(() => {
    const updateViewport = () => setViewport({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  const requestContact = async () => {
    if (!onAddContact || !accountId || !canAddContact) return;
    setRequestState('sending');
    try {
      await onAddContact(accountId);
      setRequestState('sent');
    } catch {
      setRequestState('error');
    }
  };

  const openMessage = async () => {
    if (!onMessageContact || !contact || !canMessage) return;
    setMessageState('opening');
    try {
      await onMessageContact(contact);
      onClose();
    } catch {
      setMessageState('error');
    }
  };

  const copyKordiId = async () => {
    if (!handle) return;
    try {
      await navigator.clipboard.writeText(handle);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  const openCall = (kind: 'voice' | 'video') => {
    if (!calls || !directCallConversation || !callTarget || callBusyElsewhere) return;
    onClose();
    if (!activeCall) {
      void calls.start(directCallConversation, kind);
      return;
    }
    if (callIsCurrent) calls.show();
    else void calls.join(activeCall, callTarget.sessionId);
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <button
        type="button"
        className="fixed inset-0 z-[75] cursor-default bg-transparent"
        aria-label="Close member profile"
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${participant.name} contact info`}
        data-contact-profile-surface="true"
        data-popover-placement={placement}
        className="app-transient-surface app-frosted-popover app-contact-profile-popover fixed z-[80] flex flex-col overflow-hidden rounded-[16px] shadow-[var(--app-shadow-float)]"
        style={style}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="app-contact-profile-hero relative shrink-0 px-5 pb-3 pt-5 text-center">
          <button
            ref={closeButtonRef}
            type="button"
            className="app-contact-profile-close app-transient-flat-action absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-[8px]"
            onClick={onClose}
            aria-label="Close contact info"
          >
            <X className="h-4 w-4" />
          </button>
          <IdentityAvatar
            kind="human"
            seed={participant.avatarKey ?? memberStableId(participant)}
            name={participant.name}
            imageUrl={participant.profileImageUrl ?? contact?.profileImageUrl}
            className="mx-auto h-[4.5rem] w-[4.5rem] border border-white/10"
            presenceStatus={resolvedPresence}
            presenceLabel={`${participant.name}, ${resolvedPresenceLabel}`}
          />
          <h2 className="mx-auto mt-3 max-w-[17rem] truncate text-[17px] font-semibold leading-6" title={participant.name}>
            {participant.name}
          </h2>
          <p className="mt-0.5 text-[11px] leading-4 text-[color:var(--app-transient-muted-text)]">
            {sentenceCase(resolvedPresenceLabel)}
          </p>
          {handle ? (
            <p className="mt-1 text-[11px] font-medium text-[color:var(--app-transient-muted-text)]">
              {handle}
            </p>
          ) : null}
        </header>

        <div className="app-contact-profile-actions grid shrink-0 gap-1.5 px-3 pb-3">
          {canMessage ? (
            <ProfileAction
              icon={messageState === 'opening'
                ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                : <MessageCircle className="h-4 w-4" />}
              label={messageState === 'opening' ? 'Opening…' : 'Message'}
              onClick={() => { void openMessage(); }}
              disabled={messageState === 'opening'}
            />
          ) : null}
          {calls && callTarget ? (
            activeCall ? (
              <ProfileAction
                icon={activeCall.kind === 'voice'
                  ? <Phone className="h-4 w-4" />
                  : <Video className="h-4 w-4" />}
                label={callIsCurrent ? 'Return' : 'Join call'}
                onClick={() => openCall(activeCall.kind === 'voice' ? 'voice' : 'video')}
                disabled={callBusyElsewhere}
                title={callBusyElsewhere ? 'Finish your current call first' : undefined}
              />
            ) : (
              <>
                <ProfileAction
                  icon={<Phone className="h-4 w-4" />}
                  label="Call"
                  onClick={() => openCall('voice')}
                  disabled={callBusyElsewhere}
                  title={callBusyElsewhere ? 'Finish your current call first' : undefined}
                />
                <ProfileAction
                  icon={<Video className="h-4 w-4" />}
                  label="Video"
                  onClick={() => openCall('video')}
                  disabled={callBusyElsewhere}
                  title={callBusyElsewhere ? 'Finish your current call first' : undefined}
                />
              </>
            )
          ) : null}
          {canAddContact || requestPending ? (
            <ProfileAction
              icon={requestState === 'sending'
                ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                : requestPending
                  ? <Check className="h-4 w-4" />
                  : <UserPlus className="h-4 w-4" />}
              label={requestState === 'sending' ? 'Sending…' : requestPending ? 'Requested' : 'Add contact'}
              onClick={() => { void requestContact(); }}
              disabled={requestState === 'sending' || requestPending}
            />
          ) : null}
          {handle ? (
            <ProfileAction
              icon={copyState === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              label={copyState === 'copied' ? 'Copied' : 'Copy ID'}
              onClick={() => { void copyKordiId(); }}
            />
          ) : null}
        </div>

        <div className="app-transient-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <ContactProfileSharedContent
            summary={summary}
            commonGroups={commonGroups}
            onOpenCommonGroup={onOpenCommonGroup}
          />
          {requestState === 'error' || messageState === 'error' || copyState === 'error' ? (
            <p role="alert" className="app-transient-status mt-2 px-1 text-rose-500">
              {requestState === 'error'
                ? 'Could not send the contact request.'
                : messageState === 'error'
                  ? 'Could not open the conversation.'
                  : 'Could not copy the Kordi ID.'}
            </p>
          ) : null}
        </div>
      </section>
    </>,
    document.body,
  );
}
