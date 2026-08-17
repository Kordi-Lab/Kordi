import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Film,
  Images,
  Link,
  LoaderCircle,
  MessageCircle,
  Phone,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react';

import { isApprovedCollaborationContact } from '@/features/chat/chatCreateFlows';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import { useCloudCallContext } from '@/features/cloud/useCloudCallContext';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
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
  presenceStatus?: string | null;
  onAddContact?: (accountId: string) => Promise<void> | void;
  onMessageContact?: (contact: Contact) => Promise<void> | void;
  anchorRect: ContactProfileAnchorRect;
  conversation?: Conversation | null;
  commonGroups?: ParticipantSpaceViewModel[];
  onOpenCommonGroup?: (space: ParticipantSpaceViewModel) => void;
  onClose: () => void;
};

type SharedSummaryRow = {
  key: string;
  icon: ReactNode;
  count: number;
  singular: string;
  plural: string;
  expanded?: boolean;
  onClick?: () => void;
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

function SharedProfileRow({
  icon,
  count,
  singular,
  plural,
  expanded,
  onClick,
}: {
  icon: ReactNode;
  count: number;
  singular: string;
  plural: string;
  expanded?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="app-contact-profile-summary-icon grid h-7 w-7 shrink-0 place-items-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-[11.5px] font-medium">
        {count} {count === 1 ? singular : plural}
      </span>
      {onClick ? (
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className="app-contact-profile-summary-row app-contact-profile-summary-trigger flex min-h-10 w-full items-center gap-3 px-2.5 py-2 text-left"
        onClick={onClick}
        aria-expanded={expanded}
      >
        {content}
      </button>
    );
  }
  return (
    <div className="app-contact-profile-summary-row flex min-h-10 items-center gap-3 px-2.5 py-2">
      {content}
    </div>
  );
}

function CommonGroupAvatar({ space }: { space: ParticipantSpaceViewModel }) {
  const avatars = space.avatarStack.slice(0, 2);
  if (avatars.length === 0) {
    return (
      <IdentityAvatar
        kind="human"
        seed={space.id}
        name={space.title}
        className="h-7 w-7"
      />
    );
  }
  return (
    <span className="flex h-7 w-9 shrink-0 items-center -space-x-2" aria-hidden="true">
      {avatars.map((avatar, index) => (
        <IdentityAvatar
          key={`${avatar.seed}-${index}`}
          kind={avatar.kind}
          seed={avatar.seed}
          isSelf={avatar.isSelf}
          name={space.participants.find((participant) => (
            participant.avatarKey === avatar.seed
            || participant.agentId === avatar.seed
            || participant.humanId === avatar.seed
            || participant.id === avatar.seed
            || participant.name === avatar.seed
          ))?.name ?? space.title}
          imageUrl={avatar.imageUrl ?? undefined}
          className="h-7 w-7 border border-[color:var(--app-transient-surface-fallback)]"
        />
      ))}
    </span>
  );
}

export function ContactInfoPopover({
  anchorRect,
  conversation,
  commonGroups = [],
  onClose,
  participant,
  contacts,
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
  const [commonGroupsOpen, setCommonGroupsOpen] = useState(false);
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
  const resolvedPresence = presenceStatus
    ?? contact?.presenceStatus
    ?? participant.presenceStatus
    ?? 'offline';
  const handle = formatKordiHandle(participant.kordiId)
    || formatKordiHandle(contact?.detail)
    || formatKordiHandle(contact?.subtitle);
  const summary = useMemo(
    () => contactProfileSharedSummary(conversation, commonGroups.length),
    [commonGroups.length, conversation],
  );
  const summaryRows: SharedSummaryRow[] = [
    { key: 'photos', icon: <Images className="h-3.5 w-3.5" />, count: summary.photos, singular: 'photo', plural: 'photos' },
    { key: 'videos', icon: <Film className="h-3.5 w-3.5" />, count: summary.videos, singular: 'video', plural: 'videos' },
    { key: 'files', icon: <FileText className="h-3.5 w-3.5" />, count: summary.files, singular: 'file', plural: 'files' },
    { key: 'links', icon: <Link className="h-3.5 w-3.5" />, count: summary.links, singular: 'shared link', plural: 'shared links' },
    {
      key: 'groups',
      icon: <Users className="h-3.5 w-3.5" />,
      count: summary.commonGroups,
      singular: 'group in common',
      plural: 'groups in common',
      expanded: commonGroupsOpen,
      onClick: () => setCommonGroupsOpen((open) => !open),
    },
  ].filter((row) => row.count > 0);
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
            presenceLabel={`${participant.name} is ${resolvedPresence === 'online' ? 'online' : 'offline'}`}
          />
          <h2 className="mx-auto mt-3 max-w-[17rem] truncate text-[17px] font-semibold leading-6" title={participant.name}>
            {participant.name}
          </h2>
          <p className="mt-0.5 text-[11px] leading-4 text-[color:var(--app-transient-muted-text)]">
            {resolvedPresence === 'online' ? 'Online' : 'Offline'}
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
          {summaryRows.length > 0 ? (
            <section className="app-contact-profile-summary rounded-[14px] p-1" aria-label="Shared content">
              {summaryRows.map((row) => (
                <SharedProfileRow
                  key={row.key}
                  icon={row.icon}
                  count={row.count}
                  singular={row.singular}
                  plural={row.plural}
                  expanded={row.expanded}
                  onClick={row.onClick}
                />
              ))}
              {commonGroupsOpen && commonGroups.length > 0 ? (
                <div className="app-contact-profile-group-list px-1 pb-1 pt-1" role="list" aria-label="Groups in common">
                  {commonGroups.map((space) => {
                    const content = (
                      <>
                        <CommonGroupAvatar space={space} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11.5px] font-medium" title={space.title}>
                            {space.title}
                          </span>
                          <span className="mt-0.5 block text-[9.5px] text-[color:var(--app-transient-muted-text)]">
                            {space.participantCount} member{space.participantCount === 1 ? '' : 's'}
                          </span>
                        </span>
                        {onOpenCommonGroup ? <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
                      </>
                    );
                    return onOpenCommonGroup ? (
                      <div key={space.id} role="listitem">
                        <button
                          type="button"
                          className="app-contact-profile-group-row flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left"
                          onClick={() => onOpenCommonGroup(space)}
                        >
                          {content}
                        </button>
                      </div>
                    ) : (
                      <div
                        key={space.id}
                        className="app-contact-profile-group-row flex min-h-11 items-center gap-2.5 rounded-[10px] px-2 py-1.5"
                        role="listitem"
                      >
                        {content}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          ) : (
            <div className="app-contact-profile-empty rounded-[14px] px-4 py-4 text-center text-[11px] leading-4">
              Shared photos, videos, files, and links will appear here.
            </div>
          )}
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
