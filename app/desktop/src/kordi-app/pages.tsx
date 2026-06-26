import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle, Plus, Search, Trash2, UserPlus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ContactRequestRow, ContactRow } from './components';
import { EditableIdentityAvatar } from './components/EditableIdentityAvatar';
import { IdentityAvatar } from './components/IdentityAvatar';
import type { AddContactLookupResult } from '@/pages/ChatCreateDialog';
import type { Contact, ContactClass, ContactRequest } from './types';
import { getContactSortLetter } from './utils';

type ContactsPageProps = {
  filteredGroupedContacts: Array<{ id: ContactClass; label: string; items: Contact[] }>;
  addableContacts?: Contact[];
  isContactRequestsOpen: boolean;
  onToggleRequests: () => void;
  contactRequests: ContactRequest[];
  activeContactRequestId: string;
  onAcceptRequest?: (request: ContactRequest) => Promise<void> | void;
  onRejectRequest?: (request: ContactRequest) => Promise<void> | void;
  onAddContactByNodeId?: (nodeId: string) => Promise<void> | void;
  onLookupContact?: (idOrEmail: string) => Promise<AddContactLookupResult | null>;
  contactSearch: string;
  onContactSearchChange: (value: string) => void;
  expandedContactGroups: Record<ContactClass, boolean>;
  onToggleGroup: (groupId: ContactClass) => void;
  activeContactId: string;
  onSelectContact: (groupId: ContactClass, contactId: string) => void;
  contactOverlayMode: 'contact' | 'request' | null;
  activeContact: Contact;
  activeContactRequest?: ContactRequest;
  onCloseOverlay: () => void;
  getStatusBadgeClass: (value: string) => string;
  onMessageContact?: (contact: Contact) => void;
  onRemoveContact?: (contact: Contact) => Promise<void> | void;
};

function normalizedContactText(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase();
}

export function contactDetailBodyText(contact: Contact): string {
  const detail = contact.detail.trim();
  if (!detail) return '';
  const visibleIdentifiers = new Set([
    normalizedContactText(contact.name),
    normalizedContactText(contact.subtitle),
    normalizedContactText(contact.bridgePeerNodeId),
  ].filter(Boolean));
  return visibleIdentifiers.has(normalizedContactText(detail)) ? '' : detail;
}

export function ContactsPage({
  filteredGroupedContacts,
  addableContacts = [],
  isContactRequestsOpen,
  onToggleRequests,
  contactRequests,
  activeContactRequestId,
  onAcceptRequest,
  onRejectRequest,
  onAddContactByNodeId,
  onLookupContact,
  contactSearch,
  onContactSearchChange,
  expandedContactGroups,
  onToggleGroup,
  activeContactId,
  onSelectContact,
  contactOverlayMode,
  activeContact,
  activeContactRequest,
  onCloseOverlay,
  getStatusBadgeClass,
  onMessageContact,
  onRemoveContact,
}: ContactsPageProps) {
  const [isAddContactOpen, setIsAddContactOpen] = useState(false);
  const [contactNodeId, setContactNodeId] = useState('');
  const [addContactState, setAddContactState] = useState<'idle' | 'saving' | 'sent' | 'pending' | 'error'>('idle');
  const [addContactError, setAddContactError] = useState('');
  const [lookupState, setLookupState] = useState<'idle' | 'searching' | 'error'>('idle');
  const [lookupError, setLookupError] = useState('');
  const [lookupResult, setLookupResult] = useState<AddContactLookupResult | null>(null);
  const [requestingContactNodeId, setRequestingContactNodeId] = useState<string | null>(null);
  const [requestedContactNodeIds, setRequestedContactNodeIds] = useState<string[]>([]);
  const [removeContactState, setRemoveContactState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [removeContactError, setRemoveContactError] = useState('');
  const [contactRequestAction, setContactRequestAction] = useState<{ requestId: string; kind: 'accept' | 'reject' } | null>(null);
  const [contactRequestActionError, setContactRequestActionError] = useState('');
  const [isSentInvitesOpen, setIsSentInvitesOpen] = useState(false);

  useEffect(() => {
    setRemoveContactState('idle');
    setRemoveContactError('');
  }, [activeContact.id, contactOverlayMode]);

  const performContactLookup = async () => {
    if (!onLookupContact) return;
    const accountId = contactNodeId.trim();
    if (!accountId) return;
    setLookupState('searching');
    setLookupError('');
    setLookupResult(null);
    try {
      const result = await onLookupContact(accountId);
      if (!result) {
        setLookupState('error');
        setLookupError('No account found.');
        return;
      }
      setLookupResult(result);
      setLookupState('idle');
    } catch (error) {
      setLookupState('error');
      setLookupError(error instanceof Error ? error.message : 'Search failed.');
    }
  };

  const submitAddContact = async (nodeIdInput = lookupResult?.accountId ?? contactNodeId) => {
    const nodeId = nodeIdInput.trim();
    if (!nodeId || !onAddContactByNodeId || addContactState === 'saving') return;
    if (outgoingPendingRequestAccountIds.has(nodeId) || requestedContactNodeIds.includes(nodeId) || (lookupResult?.accountId === nodeId && lookupResult.isRequestPending)) {
      setAddContactState('pending');
      setRequestedContactNodeIds((current) => (current.includes(nodeId) ? current : [...current, nodeId]));
      return;
    }
    setAddContactState('saving');
    setRequestingContactNodeId(nodeId);
    setAddContactError('');
    try {
      await onAddContactByNodeId(nodeId);
      setAddContactState('sent');
      setRequestedContactNodeIds((current) => (current.includes(nodeId) ? current : [...current, nodeId]));
      if (contactNodeId.trim() === nodeId) {
        setContactNodeId('');
        setLookupResult(null);
      }
    } catch (error) {
      setAddContactState('error');
      setAddContactError(error instanceof Error ? error.message : 'Unable to send contact request');
    } finally {
      setRequestingContactNodeId(null);
    }
  };

  const addableContactButtonLabel = (contact: Contact) => {
    const nodeId = contact.bridgePeerNodeId?.trim() ?? '';
    const status = contact.bridgeContactStatus?.trim().toLowerCase() ?? '';
    const direction = contact.bridgeContactRequestDirection?.trim().toLowerCase() ?? '';
    if (requestingContactNodeId === nodeId) return 'Sending…';
    if (requestedContactNodeIds.includes(nodeId)) return 'Requested';
    if (status === 'pending' && direction === 'outgoing') return 'Pending';
    if (status === 'pending' && direction === 'incoming') return 'Review';
    return 'Request';
  };

  const addableContactButtonDisabled = (contact: Contact) => {
    const nodeId = contact.bridgePeerNodeId?.trim() ?? '';
    const status = contact.bridgeContactStatus?.trim().toLowerCase() ?? '';
    const direction = contact.bridgeContactRequestDirection?.trim().toLowerCase() ?? '';
    return !onAddContactByNodeId
      || !nodeId
      || addContactState === 'saving'
      || requestedContactNodeIds.includes(nodeId)
      || (status === 'pending' && (direction === 'outgoing' || direction === 'incoming'));
  };

  const { incomingContactRequests, outgoingContactRequests, outgoingPendingRequestAccountIds } = useMemo(() => {
    const incoming: ContactRequest[] = [];
    const outgoing: ContactRequest[] = [];
    const outgoingAccountIds = new Set<string>();
    for (const request of contactRequests) {
      const status = request.status?.trim().toLowerCase() || 'pending';
      if (status !== 'pending') continue;
      const direction = request.direction?.trim().toLowerCase();
      if (direction === 'outgoing') {
        outgoing.push(request);
        const accountId = (request.targetNodeId || request.detail).trim();
        if (accountId) outgoingAccountIds.add(accountId);
      } else {
        incoming.push(request);
      }
    }
    return {
      incomingContactRequests: incoming,
      outgoingContactRequests: outgoing,
      outgoingPendingRequestAccountIds: outgoingAccountIds,
    };
  }, [contactRequests]);
  const pendingRequestCount = incomingContactRequests.length;
  const sentInviteCount = outgoingContactRequests.length;
  const requestInboxSummary = pendingRequestCount > 0
    ? `Review ${pendingRequestCount} pending ${pendingRequestCount === 1 ? 'request' : 'requests'}.`
    : 'No requests for you to review.';
  const sentInvitesSummary = sentInviteCount > 0
    ? `Waiting on ${sentInviteCount} ${sentInviteCount === 1 ? 'person' : 'people'} to approve.`
    : 'No sent invites waiting for approval.';
  const lookupRequestPending = Boolean(lookupResult && (lookupResult.isRequestPending || requestedContactNodeIds.includes(lookupResult.accountId)));
  const activeContactDetailBody = contactDetailBodyText(activeContact);

  const canRemoveActiveContact = Boolean(
    onRemoveContact
      && activeContact.bridgeHostId
      && activeContact.bridgePeerNodeId
      && !activeContact.id.startsWith('bridge-self:')
      && activeContact.classType !== 'my-agents',
  );

  const submitRemoveContact = async () => {
    if (!canRemoveActiveContact || removeContactState === 'saving') return;
    setRemoveContactState('saving');
    setRemoveContactError('');
    try {
      const contactToRemove = activeContact;
      onCloseOverlay();
      await onRemoveContact?.(contactToRemove);
    } catch (error) {
      setRemoveContactState('error');
      setRemoveContactError(error instanceof Error ? error.message : 'Unable to delete contact');
    }
  };

  const contactRequestActionState = (request: ContactRequest) => {
    if (contactRequestAction?.requestId !== request.id) return null;
    return contactRequestAction.kind === 'accept' ? 'accepting' : 'rejecting';
  };

  const submitContactRequestAction = async (request: ContactRequest, kind: 'accept' | 'reject') => {
    const handler = kind === 'accept' ? onAcceptRequest : onRejectRequest;
    if (!handler || contactRequestAction) return;
    setContactRequestAction({ requestId: request.id, kind });
    setContactRequestActionError('');
    try {
      await handler(request);
    } catch (error) {
      setContactRequestActionError(error instanceof Error ? error.message : `Unable to ${kind} contact request`);
    } finally {
      setContactRequestAction(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div className="flex h-full min-h-0 w-full flex-col">
        <div className="border-b border-white/10 px-5 py-4">
          <div className="w-full text-white">
            <h2 className="text-[18px] font-semibold tracking-[-0.01em]">Contacts</h2>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 px-5 py-4">
          <div className="app-contacts-content-rail flex h-full w-full min-h-0 flex-col">
            <div className="mb-4">
              <button
                type="button"
                onClick={onToggleRequests}
                className="app-contacts-section-button app-contacts-request-row flex w-full items-center justify-between gap-3 text-left transition"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium leading-5 text-white">New requests</div>
                  <div className="text-[11px] text-slate-400">{requestInboxSummary}</div>
                </div>
                <div className="flex items-center gap-2">
                  {pendingRequestCount > 0 ? (
                    <div className="app-badge-attention px-2 py-0.5 text-[10px] font-medium">{pendingRequestCount}</div>
                  ) : (
                    <div className="app-contacts-status-chip rounded-full px-2 py-0.5 text-[10px] font-medium">No pending</div>
                  )}
                  <ChevronDown className={cn('h-4 w-4 text-slate-400 transition', isContactRequestsOpen ? 'rotate-180' : '')} />
                </div>
              </button>
              {isContactRequestsOpen && (
                <div className="mt-2 grid gap-2">
                  {incomingContactRequests.length > 0 ? incomingContactRequests.map((request) => (
                    <ContactRequestRow
                      key={request.id}
                      request={request}
                      active={activeContactRequestId === request.id}
                      onAccept={() => { void submitContactRequestAction(request, 'accept'); }}
                      onReject={() => { void submitContactRequestAction(request, 'reject'); }}
                      actionState={contactRequestActionState(request)}
                    />
                  )) : null}
                  {contactRequestActionError ? (
                    <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-[12px] leading-5 text-rose-100" aria-live="polite">
                      {contactRequestActionError}
                    </div>
                  ) : null}
                  <div className="app-contacts-sent-invites-row px-3 py-3">
                    <button
                      type="button"
                      onClick={() => setIsSentInvitesOpen((open) => !open)}
                      className="flex w-full items-center justify-between gap-3 text-left"
                      aria-expanded={isSentInvitesOpen}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        {isSentInvitesOpen ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-slate-300" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                        )}
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium leading-5 text-white">Sent invites</div>
                          <div className="truncate text-[11px] leading-4 text-slate-400">{sentInvitesSummary}</div>
                        </div>
                      </div>
                      {sentInviteCount > 0 ? (
                        <div className="app-badge-attention shrink-0 px-2 py-0.5 text-[10px] font-medium">{sentInviteCount}</div>
                      ) : (
                        <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-slate-400">None sent</div>
                      )}
                    </button>
                    {isSentInvitesOpen && (
                      <div className="mt-2 grid gap-2">
                        {outgoingContactRequests.length > 0 ? outgoingContactRequests.map((request) => (
                          <div key={request.id} className="app-list-item w-full rounded-2xl bg-transparent px-3 py-2 text-white">
                            <div className="flex items-center gap-3">
                              <IdentityAvatar
                                kind="human"
                                seed={request.avatarSeed ?? request.targetNodeId ?? request.id}
                                name={request.avatarName ?? request.title}
                                imageUrl={request.profileImageUrl}
                                className="h-9 w-9 border border-white/10"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-medium leading-5">{request.title}</div>
                                <div className="truncate text-[11.5px] leading-4 text-slate-300">{request.detail}</div>
                              </div>
                              <div className="ml-auto flex shrink-0 flex-col items-end gap-1 text-right">
                                <div className="max-w-[220px] truncate text-[10.5px] leading-4 text-slate-400">{request.time}</div>
                                <div className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 text-[10.5px] font-medium leading-4 text-amber-100">
                                  Waiting for approval
                                </div>
                              </div>
                            </div>
                          </div>
                        )) : null}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="app-contacts-section-heading mb-4 flex items-center justify-start gap-2">
              <div className="text-[13px] font-medium leading-5 text-white">Contacts</div>
              <Button variant="secondary" className="app-contacts-action-chip app-contacts-add-button h-8 rounded-[8px] px-3 text-[12.5px] font-medium" onClick={() => setIsAddContactOpen((open) => !open)} disabled={!onAddContactByNodeId}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add
              </Button>
            </div>

            {isAddContactOpen && (
              <form
                className="app-surface-muted mb-4 rounded-2xl px-3 py-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (lookupResult) {
                    void submitAddContact(lookupResult.accountId);
                  } else {
                    void performContactLookup();
                  }
                }}
              >
                <div className="mb-1 text-[12px] font-medium text-white">Add contact</div>
                <div className="mb-3 text-[11px] leading-4 text-slate-400">Search by exact account ID, then send an approval request.</div>
                <div className="flex gap-2">
                  <input
                    value={contactNodeId}
                    onChange={(event) => {
                      setContactNodeId(event.target.value);
                      setLookupResult(null);
                      setLookupState('idle');
                      setLookupError('');
                      if (addContactState !== 'saving') setAddContactState('idle');
                    }}
                    placeholder="Account ID, e.g. acct_..."
                    className="app-input-shell h-8 min-w-0 flex-1 rounded-[12px] px-2.5 text-[12px] text-slate-100 outline-none"
                  />
                  <Button type="submit" className="app-contacts-action-chip h-8 rounded-full px-3 text-[12px]" disabled={!contactNodeId.trim() || lookupState === 'searching' || addContactState === 'saving' || lookupRequestPending}>
                    {lookupResult
                      ? (lookupRequestPending ? 'Request pending' : addContactState === 'saving' ? 'Sending…' : 'Send request')
                      : (lookupState === 'searching' ? 'Searching…' : 'Search')}
                  </Button>
                </div>
                {lookupResult ? (
                  <div className="app-chat-create-list-item mt-3 flex items-center justify-between gap-2 rounded-[12px] border px-2.5 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-medium leading-4 text-slate-100">{lookupResult.displayName || lookupResult.accountId}</div>
                      <div className="mt-px truncate text-[10.5px] leading-4 text-slate-400">{lookupResult.accountId}</div>
                    </div>
                    {lookupResult.isSelf ? (
                      <span className="text-[11px] text-slate-400">That's you</span>
                    ) : lookupResult.isContact ? (
                      <span className="text-[11px] text-slate-400">Already added</span>
                    ) : lookupRequestPending ? (
                      <span className="text-[11px] font-medium text-amber-100">Request pending</span>
                    ) : (
                      <Button
                        type="button"
                        className="app-contacts-action-chip h-8 w-8 shrink-0 rounded-full p-0"
                        aria-label={`Send request to ${lookupResult.displayName || lookupResult.accountId}`}
                        title="Send request"
                        disabled={addContactState === 'saving' || requestedContactNodeIds.includes(lookupResult.accountId)}
                        onClick={() => { void submitAddContact(lookupResult.accountId); }}
                      >
                        <UserPlus className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ) : null}
                <div className="mt-2 min-h-4 text-[10.5px] leading-4 text-slate-400" aria-live="polite">
                  {addContactState === 'sent'
                    ? 'Request sent. Track it under Sent invites while they review it.'
                    : addContactState === 'pending' || lookupRequestPending
                      ? 'Request pending. Track it under Sent invites while they review it.'
                      : addContactState === 'error'
                        ? addContactError || 'Unable to send contact request.'
                        : lookupState === 'error'
                          ? lookupError || 'No account found.'
                          : lookupResult
                            ? 'Send an approval request to start chatting after they accept.'
                            : 'Enter the account ID your contact shared with you.'}
                </div>
              </form>
            )}

            <div className="app-input-shell app-contacts-search mb-4 flex items-center gap-2 px-3 py-2 text-slate-300">
              <Search className="h-4 w-4" />
              <input
                value={contactSearch}
                onChange={(event) => onContactSearchChange(event.target.value)}
                placeholder="Search contacts"
                className="w-full bg-transparent text-[13px] leading-5 text-slate-100 outline-none placeholder:text-slate-400"
              />
            </div>

            <div className="relative min-h-0 flex-1">
              <ScrollArea className="h-full pr-2">
                <div className="space-y-0">
                  {filteredGroupedContacts.map((group) => (
                    <div key={group.id}>
                      <button
                        type="button"
                        onClick={() => onToggleGroup(group.id)}
                        className="app-contacts-group-row flex w-full items-center justify-between px-2 py-3 text-left transition"
                      >
                        <div className="flex items-center gap-3">
                          {expandedContactGroups[group.id] ? (
                            <ChevronDown className="h-4 w-4 text-slate-300" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-slate-300" />
                          )}
                          <span className="text-[13px] font-medium leading-5 text-white">{group.label}</span>
                        </div>
                        <div className="text-[12px] text-slate-400">{group.items.length}</div>
                      </button>
                      {expandedContactGroups[group.id] && (
                        <div className="px-0 pb-1 pt-2">
                          <div className="space-y-1">
                            {group.items.length > 0 ? (
                              group.items.map((contact, index) => {
                                const letter = getContactSortLetter(contact.name);
                                const previousLetter = index > 0 ? getContactSortLetter(group.items[index - 1].name) : null;
                                const showLetterHeader = index === 0 || previousLetter !== letter;

                                return (
                                  <div key={contact.id}>
                                    {showLetterHeader && <div className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.04em] text-slate-400">{letter}</div>}
                                    <ContactRow
                                      contact={contact}
                                      active={activeContactId === contact.id}
                                      onSelect={() => onSelectContact(group.id, contact.id)}
                                    />
                                  </div>
                                );
                              })
                            ) : (
                              <div className="rounded-2xl px-3 py-3 text-sm text-slate-400">No contacts match this search.</div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          {contactOverlayMode && (
            <div className="app-overlay absolute inset-0 z-10 flex items-center justify-center px-4 py-8 backdrop-blur-[2px]">
              <div className="app-modal-panel w-full max-w-[420px] rounded-[28px] border border-white/10 p-4 text-white shadow-[var(--app-shadow-float)]">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                      {contactOverlayMode === 'contact' ? 'Contact detail' : 'Request review'}
                    </div>
                    <div className="mt-1 text-lg font-semibold">
                      {contactOverlayMode === 'contact' ? activeContact.name : activeContactRequest?.title}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onCloseOverlay}
                    className="app-contacts-action-chip rounded-full p-2 transition"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {contactOverlayMode === 'contact' ? (
                  <div>
                    <div className="mb-4 flex items-center gap-3">
                      <EditableIdentityAvatar
                        kind={activeContact.classType === 'my-agents' || activeContact.classType === 'other-users-agents' ? 'agent' : 'human'}
                        seed={activeContact.avatarSeed ?? activeContact.bridgePeerNodeId ?? activeContact.id}
                        name={activeContact.name}
                        imageUrl={activeContact.profileImageUrl}
                        label={`${activeContact.name} avatar`}
                        compact
                        className="h-12 w-12 border border-white/10"
                      />
                      <div>
                        <div className="text-sm text-slate-300">
                          {activeContact.entityType} • {activeContact.subtitle}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Badge className={cn('rounded-full px-2.5 py-1', getStatusBadgeClass(activeContact.status))}>{activeContact.status}</Badge>
                        </div>
                      </div>
                    </div>
                    {activeContactDetailBody ? <div className="mb-5 text-sm text-slate-300">{activeContactDetailBody}</div> : null}
                    <div className="grid gap-2">
                      <Button variant="secondary" className="app-contacts-action-chip rounded-full" onClick={() => onMessageContact?.(activeContact)} disabled={!onMessageContact || !activeContact.bridgeHostId || !activeContact.bridgePeerNodeId}>
                        Message
                      </Button>
                      {canRemoveActiveContact ? (
                        <Button
                          variant="secondary"
                          className="rounded-full border-rose-400/20 bg-rose-400/10 text-rose-100 shadow-none hover:bg-rose-400/15"
                          onClick={() => { void submitRemoveContact(); }}
                          disabled={removeContactState === 'saving'}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          {removeContactState === 'saving' ? 'Deleting…' : 'Delete contact'}
                        </Button>
                      ) : null}
                    </div>
                    {canRemoveActiveContact ? (
                      <div className={cn('mt-3 text-[11px] leading-4', removeContactState === 'error' ? 'text-rose-200' : 'text-slate-400')} aria-live="polite">
                        {removeContactState === 'error'
                          ? removeContactError || 'Unable to delete contact.'
                          : 'Deleting removes both contact directions. They will need approval before messages can reach you again.'}
                      </div>
                    ) : null}
                  </div>
                ) : activeContactRequest ? (
                  <div>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="app-badge-neutral px-2.5 py-1 text-[10px] font-medium">{activeContactRequest.time}</div>
                    </div>
                    <div className="mb-5 text-sm text-slate-300">{activeContactRequest.detail}</div>
                    <div className="grid gap-2">
                      <Button variant="secondary" className="app-contacts-action-chip rounded-full" onClick={() => { void submitContactRequestAction(activeContactRequest, 'accept'); }} disabled={!onAcceptRequest || Boolean(contactRequestAction)}>
                        {contactRequestActionState(activeContactRequest) === 'accepting' ? (
                          <>
                            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                            Accepting…
                          </>
                        ) : 'Accept'}
                      </Button>
                      <Button variant="secondary" className="app-contacts-action-chip rounded-full" onClick={() => { void submitContactRequestAction(activeContactRequest, 'reject'); }} disabled={!onRejectRequest || Boolean(contactRequestAction)}>
                        {contactRequestActionState(activeContactRequest) === 'rejecting' ? (
                          <>
                            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                            Rejecting…
                          </>
                        ) : 'Reject'}
                      </Button>
                      <Button variant="secondary" className="app-contacts-action-chip rounded-full" onClick={onCloseOverlay} disabled={Boolean(contactRequestAction)}>
                        Close review
                      </Button>
                    </div>
                    {contactRequestActionState(activeContactRequest) === 'accepting' ? (
                      <div className="mt-3 text-[11px] leading-4 text-slate-400" aria-live="polite">Accepting and sending greeting…</div>
                    ) : contactRequestActionState(activeContactRequest) === 'rejecting' ? (
                      <div className="mt-3 text-[11px] leading-4 text-slate-400" aria-live="polite">Rejecting request…</div>
                    ) : contactRequestActionError ? (
                      <div className="mt-3 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-[12px] leading-5 text-rose-100" aria-live="polite">
                        {contactRequestActionError}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { AgentsPage } from './agents/AgentsPage';
export { AuthPage } from './auth/AuthPage';
