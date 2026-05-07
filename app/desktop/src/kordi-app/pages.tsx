import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, LoaderCircle, Plus, Search, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { selfObjectLabel } from '@/lib/identityLabels';
import { cn } from '@/lib/utils';
import { BridgeChip, ContactRequestRow, ContactRow } from './components';
import { EditableIdentityAvatar } from './components/EditableIdentityAvatar';
import type { Contact, ContactClass, ContactRequest } from './types';
import { getContactSortLetter } from './utils';

type ContactsPageProps = {
  filteredGroupedContacts: Array<{ id: ContactClass; label: string; items: Contact[] }>;
  addableContacts?: Contact[];
  isContactRequestsOpen: boolean;
  onToggleRequests: () => void;
  contactRequests: ContactRequest[];
  activeContactRequestId: string;
  onReviewRequest: (requestId: string) => void;
  onAcceptRequest?: (request: ContactRequest) => Promise<void> | void;
  onRejectRequest?: (request: ContactRequest) => Promise<void> | void;
  onAddContactByNodeId?: (nodeId: string) => Promise<void> | void;
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

export function ContactsPage({
  filteredGroupedContacts,
  addableContacts = [],
  isContactRequestsOpen,
  onToggleRequests,
  contactRequests,
  activeContactRequestId,
  onReviewRequest,
  onAcceptRequest,
  onRejectRequest,
  onAddContactByNodeId,
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
  const [addContactState, setAddContactState] = useState<'idle' | 'saving' | 'sent' | 'error'>('idle');
  const [addContactError, setAddContactError] = useState('');
  const [requestingContactNodeId, setRequestingContactNodeId] = useState<string | null>(null);
  const [requestedContactNodeIds, setRequestedContactNodeIds] = useState<string[]>([]);
  const [removeContactState, setRemoveContactState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [removeContactError, setRemoveContactError] = useState('');
  const [contactRequestAction, setContactRequestAction] = useState<{ requestId: string; kind: 'accept' | 'reject' } | null>(null);
  const [contactRequestActionError, setContactRequestActionError] = useState('');

  useEffect(() => {
    setRemoveContactState('idle');
    setRemoveContactError('');
  }, [activeContact.id, contactOverlayMode]);

  const submitAddContact = async (nodeIdInput = contactNodeId) => {
    const nodeId = nodeIdInput.trim();
    if (!nodeId || !onAddContactByNodeId || addContactState === 'saving') return;
    setAddContactState('saving');
    setRequestingContactNodeId(nodeId);
    setAddContactError('');
    try {
      await onAddContactByNodeId(nodeId);
      setAddContactState('sent');
      setRequestedContactNodeIds((current) => (current.includes(nodeId) ? current : [...current, nodeId]));
      if (contactNodeId.trim() === nodeId) setContactNodeId('');
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

  const pendingRequestCount = contactRequests.length;
  const requestInboxSummary = pendingRequestCount > 0
    ? `Review ${pendingRequestCount} pending ${pendingRequestCount === 1 ? 'request' : 'requests'}.`
    : 'No pending requests right now.';

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
          <div className="w-full">
            <div className="mb-1 text-white">
              <h2 className="text-[18px] font-semibold tracking-[-0.01em]">Contacts</h2>
            </div>
            <div className="text-[13px] leading-5 text-slate-400">
              Classified as my agents, other users’ agents, and other users. Compact list, detail on selection.
            </div>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 px-4 py-4">
          <div className="flex h-full w-full min-h-0 flex-col">
            <div className="mb-4">
              <button
                type="button"
                onClick={onToggleRequests}
                className="app-surface-muted flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-2.5 text-left transition"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium leading-5 text-white">New requests</div>
                  <div className="text-[11px] text-slate-400">{requestInboxSummary}</div>
                </div>
                <div className="flex items-center gap-2">
                  {pendingRequestCount > 0 ? (
                    <div className="app-badge-attention px-2 py-0.5 text-[10px] font-medium">{pendingRequestCount}</div>
                  ) : (
                    <div className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-slate-400">No pending</div>
                  )}
                  <ChevronDown className={cn('h-4 w-4 text-slate-400 transition', isContactRequestsOpen ? 'rotate-180' : '')} />
                </div>
              </button>
              {isContactRequestsOpen && (
                <div className="mt-2 grid gap-2">
                  {contactRequests.length > 0 ? contactRequests.map((request) => (
                    <ContactRequestRow
                      key={request.id}
                      request={request}
                      active={activeContactRequestId === request.id}
                      onReview={() => onReviewRequest(request.id)}
                      onAccept={() => { void submitContactRequestAction(request, 'accept'); }}
                      onReject={() => { void submitContactRequestAction(request, 'reject'); }}
                      actionState={contactRequestActionState(request)}
                    />
                  )) : (
                    <div className="app-surface-muted rounded-2xl px-3 py-3 text-[12px] text-slate-400">No pending contact approvals.</div>
                  )}
                  {contactRequestActionError ? (
                    <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-[12px] leading-5 text-rose-100" aria-live="polite">
                      {contactRequestActionError}
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium leading-5 text-white">Contacts</div>
                <div className="text-[11.5px] leading-4 text-slate-400">Foldable classes with quick letter jump.</div>
              </div>
              <Button variant="secondary" className="app-control-chip rounded-xl border-0" onClick={() => setIsAddContactOpen((open) => !open)} disabled={!onAddContactByNodeId}>
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </div>

            {isAddContactOpen && (
              <form
                className="app-surface-muted mb-4 rounded-2xl px-3 py-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitAddContact();
                }}
              >
                <div className="mb-2 text-[12px] font-medium text-white">Visible users</div>
                <div className="mb-3 grid gap-1.5">
                  {addableContacts.length > 0 ? addableContacts.map((contact) => {
                    const nodeId = contact.bridgePeerNodeId?.trim() ?? '';
                    return (
                      <div key={contact.id} className="app-chat-create-list-item flex items-center justify-between gap-2 rounded-[12px] border px-2.5 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-[12.5px] font-medium leading-4 text-slate-100">{contact.name}</div>
                          <div className="mt-px truncate text-[10.5px] leading-4 text-slate-400">{contact.subtitle || contact.detail || nodeId}</div>
                        </div>
                        <Button
                          type="button"
                          className="h-7 shrink-0 rounded-[10px] px-2.5 text-[11px]"
                          disabled={addableContactButtonDisabled(contact)}
                          onClick={() => {
                            void submitAddContact(nodeId);
                          }}
                        >
                          {addableContactButtonLabel(contact)}
                        </Button>
                      </div>
                    );
                  }) : (
                    <div className="rounded-[12px] border border-white/10 px-2.5 py-2 text-[11px] text-slate-400">No visible users to request right now.</div>
                  )}
                </div>
                <div className="mb-2 text-[12px] font-medium text-white">Add by node ID</div>
                <div className="flex gap-2">
                  <input
                    value={contactNodeId}
                    onChange={(event) => {
                      setContactNodeId(event.target.value);
                      if (addContactState !== 'saving') setAddContactState('idle');
                    }}
                    placeholder="Bridge node ID, e.g. kd_..."
                    className="app-input-shell h-8 min-w-0 flex-1 rounded-[12px] px-2.5 text-[12px] text-slate-100 outline-none"
                  />
                  <Button type="submit" className="h-8 rounded-[12px] px-3 text-[12px]" disabled={!contactNodeId.trim() || addContactState === 'saving'}>
                    {addContactState === 'saving' ? 'Sending…' : 'Request'}
                  </Button>
                </div>
                <div className="mt-2 text-[10.5px] leading-4 text-slate-400" aria-live="polite">
                  {addContactState === 'sent'
                    ? 'Request sent. They will appear in contacts after approval.'
                    : addContactState === 'error'
                      ? addContactError || 'Unable to send contact request.'
                      : 'Use this for private or unlisted Bridge users.'}
                </div>
              </form>
            )}

            <div className="app-input-shell mb-4 flex items-center gap-2 rounded-2xl px-3 py-2 text-slate-300">
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
                <div className="space-y-3">
                  {filteredGroupedContacts.map((group) => (
                    <div key={group.id}>
                      <button
                        type="button"
                        onClick={() => onToggleGroup(group.id)}
                        className="app-surface-muted flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left transition"
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
                        <div className="px-3 pb-1 pt-3">
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
                    className="app-icon-button rounded-full p-2 text-slate-300 transition hover:text-white"
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
                          <Badge variant="secondary" className="app-badge-neutral rounded-full px-2.5 py-1">
                            Owner: {selfObjectLabel(activeContact.owner)}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <div className="mb-4 text-sm text-slate-300">{activeContact.detail}</div>
                    <div className="mb-3 text-[11px] uppercase tracking-[0.22em] text-slate-400">Joined bridges</div>
                    <div className="mb-4 flex flex-wrap gap-2">
                      {activeContact.bridges.map((bridge) => (
                        <BridgeChip key={bridge} bridge={bridge} />
                      ))}
                    </div>
                    <div className="mb-3 text-[11px] uppercase tracking-[0.22em] text-slate-400">Discoverable on</div>
                    <div className="mb-5 flex flex-wrap gap-2">
                      {activeContact.discoverableOn.map((bridge) => (
                        <BridgeChip key={bridge} bridge={bridge} />
                      ))}
                    </div>
                    <div className="grid gap-2">
                      <Button className="rounded-xl" onClick={() => onMessageContact?.(activeContact)} disabled={!onMessageContact || !activeContact.bridgeHostId || !activeContact.bridgePeerNodeId}>
                        Message
                      </Button>
                      <Button variant="secondary" className="rounded-xl">
                        <Eye className="mr-2 h-4 w-4" />
                        View full profile
                      </Button>
                      {canRemoveActiveContact ? (
                        <Button
                          variant="secondary"
                          className="rounded-xl border-rose-400/20 bg-rose-400/10 text-rose-100 hover:bg-rose-400/15"
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
                      <Button className="rounded-xl" onClick={() => { void submitContactRequestAction(activeContactRequest, 'accept'); }} disabled={!onAcceptRequest || Boolean(contactRequestAction)}>
                        {contactRequestActionState(activeContactRequest) === 'accepting' ? (
                          <>
                            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                            Accepting…
                          </>
                        ) : 'Accept'}
                      </Button>
                      <Button variant="secondary" className="rounded-xl" onClick={() => { void submitContactRequestAction(activeContactRequest, 'reject'); }} disabled={!onRejectRequest || Boolean(contactRequestAction)}>
                        {contactRequestActionState(activeContactRequest) === 'rejecting' ? (
                          <>
                            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                            Rejecting…
                          </>
                        ) : 'Reject'}
                      </Button>
                      <Button variant="secondary" className="rounded-xl" onClick={onCloseOverlay} disabled={Boolean(contactRequestAction)}>
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
