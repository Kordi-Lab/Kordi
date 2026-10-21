import { useState } from 'react';
import { Ban, Check, Flag, LoaderCircle, MessageCircle, Share, Trash2, X } from 'lucide-react';

import { formatKordiHandle } from '@/features/cloud/kordiId';
import { defaultAgentDisplayName } from '@/lib/identityLabels';
import { formatDesktopContactRequestTimeLabel } from '@/lib/time';
import { IdentityAvatar } from '../components/IdentityAvatar';
import {
  contactCanBeRemoved,
  contactDetailBodyText,
  contactKordiHandle,
  contactPresenceStatus,
  contactRequestDisplayName,
  contactSecondaryLine,
  isAgentContact,
  isOutgoingContactRequest,
} from '../contactPresentation';
import type { Contact, ContactRequest } from '../types';
import { CopyButton, DetailHeader, DetailTile, DetailTiles, InfoCard, type InfoCardRow } from './ContactDetailParts';
import { CommonGroundCard, DeleteContactCard, SharedWithYouCard, SharedWithYouLoading } from './ContactProfileCards';
import { contactProfileKind, formatContactSince, type ContactProfileKind } from './contactProfileHost';
import { MenuTile, MuteTile, SettingsTile, ShareTile, type TileMenuItem } from './ContactProfileTiles';
import type { ContactsPageProps } from './contactsPageTypes';
import { useContactProfile, type ContactProfileState } from './useContactProfile';
import type { ContactRequestActions } from './useContactsPageState';
import { usePresenceNow } from './usePresenceNow';
import { useContactSharedPages } from './useContactSharedPages';

type ContactDetailPaneProps = Pick<ContactsPageProps,
  | 'activeContact' | 'activeContactRequest' | 'onCloseOverlay' | 'onMessageContact' | 'onRemoveContact'
  | 'contactProfileHost' | 'contactMute' | 'onOpenAgentSettings' | 'sharedConversationFor'
> & {
  mode: 'contact' | 'request';
  requestActions: ContactRequestActions;
};

const DETAIL_AVATAR_CLASS = 'app-contacts-avatar app-contacts-detail-avatar h-24 w-24 shrink-0';

function kordiIdRow(handle: string): InfoCardRow {
  return {
    key: 'kordi-id',
    value: handle,
    caption: 'Kordi ID',
    accent: true,
    trailing: <CopyButton value={handle} label="Copy Kordi ID" />,
  };
}

type ContactDetailBodyProps = Pick<ContactsPageProps,
  'onMessageContact' | 'onRemoveContact' | 'contactProfileHost' | 'contactMute' | 'onOpenAgentSettings' | 'sharedConversationFor'
> & {
  contact: Contact;
  onCloseOverlay: () => void;
};

function avatarLead(kind: 'agent' | 'human', seed: string, name: string, imageUrl: string | null) {
  return <IdentityAvatar kind={kind} seed={seed} name={name} imageUrl={imageUrl} cornerRadius="50%" className="h-7 w-7 shrink-0" />;
}

function headerLineFor(contact: Contact, kind: ContactProfileKind, state: ContactProfileState, presenceLine: string, handle: string | null) {
  const profile = state.profile;
  if (kind === 'own-agent' && state.status !== 'unavailable') return 'Your agent';
  if (kind === 'agent' && profile?.owner) return `Agent · owned by ${profile.owner.displayName}`;
  return presenceLine && presenceLine !== handle && presenceLine !== contact.name ? presenceLine : '';
}

/** The row's presence, replaced by the profile's once it loads. */
function withProfilePresence(contact: Contact, state: ContactProfileState): Contact {
  const presence = state.profile?.presence;
  return presence ? { ...contact, presenceStatus: presence.status, presenceLastSeenAt: presence.lastSeenAt } : contact;
}

/** The contact profile: header, tiles, info card, shared and common ground cards, and Delete. */
function ContactDetailBody({
  contact: row, onCloseOverlay, onMessageContact, onRemoveContact, contactProfileHost, contactMute, onOpenAgentSettings, sharedConversationFor,
}: ContactDetailBodyProps) {
  const now = usePresenceNow();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [removeState, setRemoveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [removeError, setRemoveError] = useState('');
  const state = useContactProfile(row, contactProfileHost);
  const shared = useContactSharedPages(row, sharedConversationFor);
  const profile = state.profile;
  const contact = withProfilePresence(row, state);
  // The richer layout shows whenever the server can serve a profile; the request only fills cards.
  const rich = state.status !== 'unavailable';
  const kind = contactProfileKind(contact, profile);
  const isAgent = isAgentContact(contact) || kind === 'agent';
  const presenceStatus = contactPresenceStatus(contact);
  const detailBody = contactDetailBodyText(contact);
  const handle = formatKordiHandle(profile?.kordiId ?? '') || contactKordiHandle(contact);
  const secondaryLine = contactSecondaryLine(contact, now);
  const headerLine = headerLineFor(contact, kind, state, secondaryLine.text, handle);
  const canRemove = Boolean(onRemoveContact && contactCanBeRemoved(contact));
  const canMessage = Boolean(onMessageContact && contact.sourceHostId && contact.sourceParticipantId);
  const openChat = canMessage ? () => onMessageContact?.(contact) : undefined;
  const about = profile?.about ?? (detailBody && detailBody !== headerLine ? detailBody : '');
  const rows: InfoCardRow[] = [];
  if (handle) rows.push(kordiIdRow(handle));
  if (about) rows.push({ key: 'about', value: about, caption: 'About' });
  if (isAgent) rows.push({ key: 'type', value: 'Agent', caption: 'Type' });
  const agent = profile?.defaultAgent;
  if (agent) {
    const openAgent = contactProfileHost?.openAgentChat;
    rows.push({
      key: 'agent',
      // A stock "Kordi" agent reads as "<owner>'s Kordi", as in chats.
      value: defaultAgentDisplayName(profile?.displayName ?? contact.name, agent.displayName),
      caption: 'Their agent',
      lead: avatarLead('agent', agent.avatarSeed ?? agent.agentId, agent.displayName || 'Kordi', agent.avatarUrl),
      onClick: openAgent ? () => openAgent(agent, contact) : undefined,
    });
  }
  const owner = profile?.owner;
  if (owner) {
    const ownerContact = contactProfileHost?.contactForAccount?.(owner.accountId) ?? null;
    const select = contactProfileHost?.selectContact;
    rows.push({
      key: 'owner',
      value: owner.displayName,
      caption: 'Owner',
      lead: avatarLead('human', owner.accountId, owner.displayName, owner.avatarUrl),
      onClick: ownerContact && select ? () => select(ownerContact) : undefined,
    });
  }
  const since = formatContactSince(profile?.contactSince);
  if (since) rows.push({ key: 'since', value: since, caption: 'Contact since' });

  const muted = contactMute?.isMuted(contact) ?? null;
  const deleteItem: TileMenuItem[] = canRemove
    ? [{ kind: 'item', key: 'delete', label: 'Delete contact', icon: <Trash2 className="h-4 w-4" aria-hidden="true" />, danger: true, onSelect: () => setIsConfirmOpen(true) }]
    : [];
  const menuItems: TileMenuItem[] = !rich ? deleteItem : kind === 'own-agent'
    ? [{ kind: 'item', key: 'share', label: 'Share', icon: <Share className="h-4 w-4" aria-hidden="true" />, disabled: true }]
    : [
        { kind: 'item', key: 'block', label: 'Block', icon: <Ban className="h-4 w-4" aria-hidden="true" />, disabled: true },
        { kind: 'item', key: 'report', label: 'Report', icon: <Flag className="h-4 w-4" aria-hidden="true" />, disabled: true },
        ...(deleteItem.length ? [{ kind: 'separator' as const, key: 'sep' }, ...deleteItem] : []),
      ];
  const showMenu = menuItems.length > 0 && (rich ? kind !== 'system' : canRemove);
  const showShared = rich && (kind === 'person' || kind === 'agent');

  const submitRemoveContact = async () => {
    if (!canRemove || removeState === 'saving') return;
    setRemoveState('saving');
    setRemoveError('');
    try {
      onCloseOverlay();
      await onRemoveContact?.(contact);
    } catch (error) {
      setRemoveState('error');
      setRemoveError(error instanceof Error ? error.message : 'Unable to delete contact');
    }
  };

  if (shared.page) return shared.page;

  return (
    <>
      {rich ? <div className="app-contacts-detail-wash pointer-events-none absolute top-0" aria-hidden="true" /> : null}
      <DetailHeader
        avatar={(
          <IdentityAvatar
            kind={isAgent ? 'agent' : 'human'}
            seed={contact.avatarSeed ?? contact.sourceParticipantId ?? contact.id}
            name={contact.name}
            imageUrl={contact.profileImageUrl}
            presenceStatus={presenceStatus}
            presenceLabel={presenceStatus ? `${contact.name} is ${presenceStatus}` : undefined}
            cornerRadius="50%"
            className={DETAIL_AVATAR_CLASS}
          />
        )}
        name={contact.name}
        line={headerLine}
        lineAccent={secondaryLine.online && headerLine === secondaryLine.text}
      />
      <DetailTiles>
        <DetailTile
          icon={<MessageCircle className="h-5 w-5" aria-hidden="true" />}
          label="Message"
          onClick={() => onMessageContact?.(contact)}
          disabled={!canMessage}
        />
        {rich && kind === 'person' ? (
          <MuteTile muted={muted} onToggle={contactMute && muted !== null ? () => { void contactMute.setMuted(contact, !muted); } : undefined} />
        ) : null}
        {rich && kind === 'own-agent' ? <SettingsTile onOpen={onOpenAgentSettings} /> : null}
        {rich && (kind === 'person' || kind === 'agent') ? <ShareTile handle={handle} /> : null}
        {showMenu ? <MenuTile items={menuItems} /> : null}
      </DetailTiles>
      <InfoCard rows={rows} />
      {showShared && state.status === 'loading' ? <SharedWithYouLoading /> : null}
      {showShared && profile ? (
        <SharedWithYouCard
          shared={profile.shared}
          local={shared.counts}
          onOpenPage={shared.open}
          onOpenChat={openChat}
          onOpenGroup={contactProfileHost?.openGroup}
        />
      ) : null}
      {profile?.commonGround ? <CommonGroundCard card={profile.commonGround} /> : null}
      {canRemove ? (
        <DeleteContactCard
          confirmOpen={isConfirmOpen}
          removeState={removeState}
          removeError={removeError}
          onOpenConfirm={() => setIsConfirmOpen(true)}
          onCancel={() => {
            setIsConfirmOpen(false);
            setRemoveState('idle');
          }}
          onDelete={() => { void submitRemoveContact(); }}
        />
      ) : null}
    </>
  );
}

function RequestActionStatus({ state, error }: { state: ReturnType<ContactRequestActions['stateFor']>; error: string }) {
  if (state === 'accepting') {
    return <div className="app-contacts-muted mt-3 text-center text-[12px] leading-4" aria-live="polite">Accepting and sending greeting…</div>;
  }
  if (state === 'rejecting') {
    return <div className="app-contacts-muted mt-3 text-center text-[12px] leading-4" aria-live="polite">Rejecting request…</div>;
  }
  if (error) {
    return <div className="app-error-text app-contacts-error mt-3 text-center text-[12px] leading-5" aria-live="polite">{error}</div>;
  }
  return null;
}

function ContactRequestDetailBody({ request, requestActions }: { request: ContactRequest; requestActions: ContactRequestActions }) {
  const state = requestActions.stateFor(request);
  const name = contactRequestDisplayName(request);
  const outgoing = isOutgoingContactRequest(request);
  const isAgent = /agent/i.test(request.title);
  const handle = formatKordiHandle(request.detail);
  const note = request.detail.trim() && !handle ? request.detail.trim() : '';
  const timestampMs = Date.parse(request.time);
  const rows: InfoCardRow[] = [];
  if (handle) rows.push(kordiIdRow(handle));
  rows.push({
    key: 'requested',
    value: (
      <time className="app-contacts-detail-time" dateTime={Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : undefined}>
        {formatDesktopContactRequestTimeLabel(request.time)}
      </time>
    ),
    caption: 'Requested',
  });
  if (note) rows.push({ key: 'note', value: note, caption: 'Note' });

  return (
    <>
      <DetailHeader
        avatar={(
          <IdentityAvatar
            kind={isAgent ? 'agent' : 'human'}
            seed={request.avatarSeed ?? request.targetNodeId ?? request.id}
            name={name}
            imageUrl={request.profileImageUrl}
            cornerRadius="50%"
            className={DETAIL_AVATAR_CLASS}
          />
        )}
        name={name}
        line={outgoing ? 'Awaiting approval' : 'Wants to connect'}
      />
      {outgoing ? null : (
        <>
          <DetailTiles>
            <DetailTile
              tone="primary"
              icon={state === 'accepting'
                ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
                : <Check className="h-5 w-5" aria-hidden="true" />}
              label={state === 'accepting' ? 'Accepting…' : 'Accept'}
              onClick={() => { void requestActions.submit(request, 'accept'); }}
              disabled={requestActions.busy || !requestActions.canAccept}
            />
            <DetailTile
              tone="danger"
              icon={state === 'rejecting'
                ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
                : <X className="h-5 w-5" aria-hidden="true" />}
              label={state === 'rejecting' ? 'Rejecting…' : 'Reject'}
              onClick={() => { void requestActions.submit(request, 'reject'); }}
              disabled={requestActions.busy || !requestActions.canReject}
            />
          </DetailTiles>
          <RequestActionStatus state={state} error={requestActions.error} />
        </>
      )}
      <InfoCard rows={rows} />
    </>
  );
}

/** Contact or request detail, shared by the split-view pane and the narrow-window dialog. */
export function ContactDetailContent({
  mode,
  activeContact,
  activeContactRequest,
  onCloseOverlay,
  onMessageContact,
  onRemoveContact,
  contactProfileHost,
  contactMute,
  onOpenAgentSettings,
  sharedConversationFor,
  requestActions,
}: ContactDetailPaneProps) {
  if (mode === 'request' && !activeContactRequest) return null;
  return (
    <div className="app-contacts-detail-content relative mx-auto w-full max-w-[420px] px-6 pb-10 pt-10">
      <button
        type="button"
        onClick={onCloseOverlay}
        aria-label="Close"
        title="Close"
        disabled={mode === 'request' && requestActions.busy}
        className="app-contacts-icon-button app-contacts-detail-close absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-[8px] disabled:pointer-events-none disabled:opacity-50"
      >
        <X className="h-4 w-4" />
      </button>
      {mode === 'contact' ? (
        <ContactDetailBody
          key={activeContact.id}
          contact={activeContact}
          onCloseOverlay={onCloseOverlay}
          onMessageContact={onMessageContact}
          onRemoveContact={onRemoveContact}
          contactProfileHost={contactProfileHost}
          contactMute={contactMute}
          onOpenAgentSettings={onOpenAgentSettings}
          sharedConversationFor={sharedConversationFor}
        />
      ) : activeContactRequest ? (
        <ContactRequestDetailBody request={activeContactRequest} requestActions={requestActions} />
      ) : null}
    </div>
  );
}

function contactDetailLabel(mode: 'contact' | 'request', activeContact: Contact) {
  return mode === 'contact' ? `${activeContact.name} contact details` : 'Contact request review';
}

export function ContactDetailPane(props: ContactDetailPaneProps) {
  return (
    <section
      aria-label={contactDetailLabel(props.mode, props.activeContact)}
      className="app-contacts-detail-pane relative min-h-0 min-w-0 flex-1 overflow-y-auto"
    >
      <ContactDetailContent {...props} />
    </section>
  );
}

export function ContactDetailDialog(props: ContactDetailPaneProps) {
  return (
    <div className="app-transient-overlay app-overlay absolute inset-0 z-10 flex items-center justify-center px-4 py-8 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={contactDetailLabel(props.mode, props.activeContact)}
        className="app-transient-surface app-modal-panel app-contact-detail-dialog relative w-full max-w-[440px] rounded-[18px] border"
      >
        <ContactDetailContent {...props} />
      </div>
    </div>
  );
}

export function ContactDetailEmpty() {
  return (
    <section aria-label="Contact details" className="app-contacts-detail-pane flex min-h-0 min-w-0 flex-1 items-center justify-center">
      <div className="app-contacts-muted text-[13px]">No contact selected</div>
    </section>
  );
}
