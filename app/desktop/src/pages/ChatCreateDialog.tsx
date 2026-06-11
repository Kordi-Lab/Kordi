import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Bot, MessageSquare, UserPlus, Users, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  buildChatCreateAgentOptions,
  buildChatCreateGroupPersonOptions,
  buildChatCreatePersonOptions,
  canCreateGroup,
  groupDefaultName,
} from '@/features/chat/chatCreateFlows';
import type { Agent, Contact } from '@/kordi-app/types';
import type { CreateChatGroupRequest } from '@/app/kordiShellSlots.types';
import { cn } from '@/lib/utils';

export type ChatCreatePopoverAnchor = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type AddContactLookupResult = {
  accountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isContact: boolean;
  isSelf: boolean;
  isRequestPending?: boolean;
};

export type ChatCreateDialogProps = {
  isOpen: boolean;
  contacts: Contact[];
  addableContacts?: Contact[];
  agents: Agent[];
  onClose: () => void;
  onStartPerson: (contact: Contact) => Promise<void> | void;
  onStartAgent: (agent: Agent) => Promise<void> | void;
  onCreateGroup: (request: CreateChatGroupRequest) => Promise<void> | void;
  onAddContact?: (nodeId: string) => Promise<void> | void;
  /** Optional account lookup. When provided the Add-contacts mode shows
   * a search-first UX (input → search → profile preview → Add) instead
   * of the direct-send fallback. Cloud edition wires this through to
   * the auth client's getProfile call so users see who they're about
   * to request before sending. */
  onLookupContact?: (idOrEmail: string) => Promise<AddContactLookupResult | null>;
  /** Override the placeholder shown in the Add-contacts input. Cloud
   * uses "acct_…" while local bridge uses "kd_…". */
  addContactPlaceholder?: string;
  initialMode?: CreateMode;
  anchorRect?: ChatCreatePopoverAnchor | null;
};

type CreateMode = 'menu' | 'person' | 'agent' | 'group' | 'add-contact';
type PopoverPlacement = 'right' | 'left' | 'floating';
type PopoverStyle = CSSProperties & {
  '--app-create-enter-x'?: string;
  '--app-popover-origin'?: string;
};

type PopoverGeometry = {
  style: PopoverStyle;
  arrowStyle: CSSProperties;
  placement: PopoverPlacement;
};

function popoverGeometry(anchorRect?: ChatCreatePopoverAnchor | null): PopoverGeometry {
  const width = 284;
  const gap = 10;
  const margin = 10;
  const fallbackLeft = 92;
  const fallbackTop = 74;

  if (!anchorRect) {
    return {
      placement: 'floating',
      arrowStyle: { top: 18 },
      style: {
        left: fallbackLeft,
        top: fallbackTop,
        '--app-create-enter-x': '-6px',
        '--app-popover-origin': 'left 22px',
      },
    };
  }

  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const rightLeft = anchorRect.left + anchorRect.width + gap;
  const leftLeft = anchorRect.left - width - gap;
  const canFitRight = rightLeft + width <= viewportWidth - margin;
  const canFitLeft = leftLeft >= margin;
  const placement: PopoverPlacement = canFitRight || !canFitLeft ? 'right' : 'left';
  const unclampedLeft = placement === 'right' ? rightLeft : leftLeft;
  const left = Math.min(Math.max(margin, unclampedLeft), Math.max(margin, viewportWidth - width - margin));
  const top = Math.min(Math.max(margin, anchorRect.top - 4), Math.max(margin, viewportHeight - 220));
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;
  const arrowTop = Math.min(Math.max(18, anchorCenterY - top - 6), 54);

  return {
    placement,
    arrowStyle: { top: arrowTop },
    style: {
      left,
      top,
      '--app-create-enter-x': placement === 'right' ? '-8px' : '8px',
      '--app-popover-origin': placement === 'right' ? 'left 22px' : 'right 22px',
    },
  };
}

function DialogCard({ children, onClose, anchorRect }: { children: ReactNode; onClose: () => void; anchorRect?: ChatCreatePopoverAnchor | null }) {
  const { style, arrowStyle, placement } = popoverGeometry(anchorRect);

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 cursor-default bg-transparent"
        aria-label="Close create chat"
        onClick={onClose}
      />
      <div
        data-create-surface="side-popover"
        data-popover-placement={placement}
        className="app-frosted-popover app-chat-create-popover app-chat-create-popover-enter fixed z-50 w-[min(17.75rem,calc(100vw-1.25rem))] overflow-hidden rounded-[18px] p-2.5 backdrop-blur-2xl backdrop-saturate-150"
        style={style}
      >
        {placement !== 'floating' ? (
          <div
            aria-hidden="true"
            className={cn(
              'app-chat-create-popover-arrow absolute h-3.5 w-3.5 rotate-45',
              placement === 'right' ? '-left-[0.45rem]' : '-right-[0.45rem]',
            )}
            style={arrowStyle}
          />
        ) : null}
        <div className="relative">{children}</div>
      </div>
    </>
  );
}

function CreateDialogHeader({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="mb-2 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold leading-5 text-[color:var(--utility-foreground)]">{title}</div>
        <div className="mt-px text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">{subtitle}</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="app-chat-create-close grid h-6 w-6 shrink-0 place-items-center rounded-[9px] transition"
        aria-label="Close create chat"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ChoiceButton({ icon, title, detail, onClick }: { icon: ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="app-chat-create-choice flex w-full items-center gap-2 rounded-[13px] px-2 py-2 text-left transition"
    >
      <span className="app-chat-create-icon grid h-7 w-7 shrink-0 place-items-center rounded-[10px]">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-semibold leading-4 text-[color:var(--utility-foreground)]">{title}</span>
        <span className="mt-px block truncate text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">{detail}</span>
      </span>
    </button>
  );
}

export function ChatCreateDialog({
  isOpen,
  contacts,
  addableContacts = [],
  agents,
  onClose,
  onStartPerson,
  onStartAgent,
  onCreateGroup,
  onAddContact,
  onLookupContact,
  addContactPlaceholder,
  initialMode = 'menu',
  anchorRect = null,
}: ChatCreateDialogProps) {
  const [mode, setMode] = useState<CreateMode>(initialMode);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [contactNodeId, setContactNodeId] = useState('');
  const [addContactState, setAddContactState] = useState<'idle' | 'saving' | 'sent' | 'pending' | 'error'>('idle');
  const [addContactError, setAddContactError] = useState('');
  const [requestingContactNodeId, setRequestingContactNodeId] = useState<string | null>(null);
  const [requestedContactNodeIds, setRequestedContactNodeIds] = useState<string[]>([]);
  const [lookupState, setLookupState] = useState<'idle' | 'searching' | 'error'>('idle');
  const [lookupError, setLookupError] = useState('');
  const [lookupResult, setLookupResult] = useState<AddContactLookupResult | null>(null);
  const personOptions = useMemo(() => buildChatCreatePersonOptions(contacts), [contacts]);
  const groupPersonOptions = useMemo(() => buildChatCreateGroupPersonOptions(contacts), [contacts]);
  const agentOptions = useMemo(() => buildChatCreateAgentOptions(agents), [agents]);
  const visibleAddableContacts = useMemo(() => addableContacts.filter((contact) => contact.bridgePeerNodeId?.trim()), [addableContacts]);
  const selectedPeople = groupPersonOptions.filter((option) => selectedContactIds.includes(option.id));
  const selectedGroupContactIds = selectedPeople.map((option) => option.id);
  const defaultGroupName = groupDefaultName(selectedPeople.map((option) => option.label));
  const canSubmitGroup = canCreateGroup(selectedGroupContactIds);
  const addContactSubtitle = onLookupContact
    ? 'Send an approval request by Kordi account ID.'
    : 'Send an approval request by Bridge node ID.';
  const lookupRequestPending = Boolean(lookupResult && (lookupResult.isRequestPending || requestedContactNodeIds.includes(lookupResult.accountId)));

  if (!isOpen) return null;

  const close = () => {
    setMode('menu');
    setSelectedContactIds([]);
    setGroupName('');
    setContactNodeId('');
    setAddContactState('idle');
    setAddContactError('');
    setRequestingContactNodeId(null);
    setRequestedContactNodeIds([]);
    setLookupState('idle');
    setLookupError('');
    setLookupResult(null);
    onClose();
  };

  const performLookup = async () => {
    if (!onLookupContact) return;
    const trimmed = contactNodeId.trim();
    if (!trimmed) return;
    setLookupState('searching');
    setLookupError('');
    setLookupResult(null);
    try {
      const result = await onLookupContact(trimmed);
      if (!result) {
        setLookupState('error');
        setLookupError('No account found.');
        return;
      }
      setLookupResult(result);
      setLookupState('idle');
    } catch (error) {
      setLookupState('error');
      setLookupError(error instanceof Error ? error.message : 'Lookup failed.');
    }
  };

  const submitAddContact = async (nodeIdInput: string) => {
    const nodeId = nodeIdInput.trim();
    if (!nodeId || !onAddContact || addContactState === 'saving') return;
    if (requestedContactNodeIds.includes(nodeId) || (lookupResult?.accountId === nodeId && lookupResult.isRequestPending)) {
      setAddContactState('pending');
      setRequestedContactNodeIds((current) => (current.includes(nodeId) ? current : [...current, nodeId]));
      return;
    }
    setAddContactState('saving');
    setRequestingContactNodeId(nodeId);
    setAddContactError('');
    try {
      await onAddContact(nodeId);
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

  const addContactButtonLabel = (contact: Contact) => {
    const nodeId = contact.bridgePeerNodeId?.trim() ?? '';
    const status = contact.bridgeContactStatus?.trim().toLowerCase() ?? '';
    const direction = contact.bridgeContactRequestDirection?.trim().toLowerCase() ?? '';
    if (requestingContactNodeId === nodeId) return 'Sending…';
    if (requestedContactNodeIds.includes(nodeId)) return 'Requested';
    if (status === 'pending' && direction === 'outgoing') return 'Pending';
    if (status === 'pending' && direction === 'incoming') return 'Review';
    return 'Request';
  };

  const addContactButtonDisabled = (contact: Contact) => {
    const nodeId = contact.bridgePeerNodeId?.trim() ?? '';
    const status = contact.bridgeContactStatus?.trim().toLowerCase() ?? '';
    const direction = contact.bridgeContactRequestDirection?.trim().toLowerCase() ?? '';
    return !onAddContact
      || !nodeId
      || addContactState === 'saving'
      || requestedContactNodeIds.includes(nodeId)
      || (status === 'pending' && (direction === 'outgoing' || direction === 'incoming'));
  };

  const toggleContact = (contactId: string) => {
    setSelectedContactIds((current) => (
      current.includes(contactId)
        ? current.filter((id) => id !== contactId)
        : [...current, contactId]
    ));
  };

  return (
    <DialogCard onClose={close} anchorRect={anchorRect}>
      <CreateDialogHeader
        title={mode === 'menu' ? 'Start a chat' : mode === 'person' ? 'Chat with contact' : mode === 'agent' ? 'Chat with agent' : mode === 'add-contact' ? 'Add contact' : 'Start group'}
        subtitle={mode === 'group' ? 'Select at least 2 people. Agents are added later.' : mode === 'add-contact' ? addContactSubtitle : 'Choose who this conversation is with.'}
        onClose={close}
      />

      {mode === 'menu' ? (
        <div className="space-y-1">
          <ChoiceButton icon={<MessageSquare className="h-3.5 w-3.5" />} title="Chat with contact" detail="Direct contact conversation" onClick={() => setMode('person')} />
          <ChoiceButton icon={<Bot className="h-3.5 w-3.5" />} title="Chat with agent" detail="Start with one Kordi agent" onClick={() => setMode('agent')} />
          <ChoiceButton icon={<Users className="h-3.5 w-3.5" />} title="Start group" detail="Stable group with people only" onClick={() => setMode('group')} />
          <ChoiceButton icon={<UserPlus className="h-3.5 w-3.5" />} title="Add contacts" detail="Request a private Bridge node" onClick={() => setMode('add-contact')} />
        </div>
      ) : null}

      {mode === 'person' ? (
        <div className="space-y-2">
          <div className="app-chat-create-option-list max-h-[min(18rem,calc(100vh-8rem))] space-y-1 overflow-auto pr-1">
            {personOptions.length > 0 ? personOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  void onStartPerson(option.contact);
                  close();
                }}
                className="app-chat-create-list-item w-full rounded-[12px] border px-2.5 py-2 text-left transition"
              >
                <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">{option.label}</span>
                <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">{option.detail}</span>
              </button>
            )) : (
              <div className="app-chat-create-empty rounded-[12px] border px-2.5 py-2.5 text-[11px]">No contacts available.</div>
            )}
          </div>
          <Button type="button" variant="secondary" className="h-8 w-full rounded-[12px] text-[12px]" onClick={() => setMode('menu')}>Back</Button>
        </div>
      ) : null}

      {mode === 'agent' ? (
        <div className="space-y-2">
          <div className="app-chat-create-option-list max-h-[min(18rem,calc(100vh-8rem))] space-y-1 overflow-auto pr-1">
            {agentOptions.length > 0 ? agentOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  void onStartAgent(option.agent);
                  close();
                }}
                className="app-chat-create-list-item w-full rounded-[12px] border px-2.5 py-2 text-left transition"
              >
                <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">{option.label}</span>
                <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">{option.detail}</span>
              </button>
            )) : (
              <div className="app-chat-create-empty rounded-[12px] border px-2.5 py-2.5 text-[11px]">No agents available.</div>
            )}
          </div>
          <Button type="button" variant="secondary" className="h-8 w-full rounded-[12px] text-[12px]" onClick={() => setMode('menu')}>Back</Button>
        </div>
      ) : null}

      {mode === 'add-contact' && onLookupContact ? (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (lookupResult) {
              await submitAddContact(lookupResult.accountId);
            } else {
              await performLookup();
            }
          }}
        >
          <input
            value={contactNodeId}
            onChange={(event) => {
              setContactNodeId(event.target.value);
              setLookupResult(null);
              setLookupState('idle');
              setLookupError('');
              if (addContactState !== 'saving') setAddContactState('idle');
            }}
            placeholder={addContactPlaceholder ?? 'Account ID, e.g. acct_...'}
            className="app-input-shell h-8 w-full rounded-[12px] px-2.5 text-[12px] outline-none"
            autoFocus
          />

          {lookupResult ? (
            <div className="app-chat-create-list-item flex items-center justify-between gap-2 rounded-[12px] border px-2.5 py-2">
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">
                  {lookupResult.displayName || lookupResult.accountId}
                </span>
                <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">
                  {lookupResult.accountId}
                </span>
              </span>
              {lookupResult.isSelf ? (
                <span className="text-[11px] text-[color:var(--utility-muted-text)]">That's you</span>
              ) : lookupResult.isContact ? (
                <span className="text-[11px] text-[color:var(--utility-muted-text)]">Already in contacts</span>
              ) : lookupRequestPending ? (
                <span className="text-[11px] font-medium text-amber-100">Request pending</span>
              ) : (
                <Button
                  type="button"
                  className="h-7 shrink-0 rounded-[10px] px-2.5 text-[11px]"
                  disabled={addContactState === 'saving' || requestedContactNodeIds.includes(lookupResult.accountId)}
                  onClick={() => {
                    void submitAddContact(lookupResult.accountId);
                  }}
                >
                  {addContactState === 'saving'
                    ? 'Sending…'
                    : requestedContactNodeIds.includes(lookupResult.accountId)
                      ? 'Requested'
                      : 'Add'}
                </Button>
              )}
            </div>
          ) : null}

          <div className="min-h-4 text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]" aria-live="polite">
            {addContactState === 'sent'
              ? 'Request sent. Track it under Sent invites while they review it.'
              : addContactState === 'pending' || lookupRequestPending
                ? 'Request pending. Track it under Sent invites while they review it.'
                : lookupState === 'error'
                  ? lookupError || 'Lookup failed.'
                  : addContactState === 'error'
                    ? addContactError || 'Unable to send contact request.'
                    : lookupResult
                      ? 'Tap Add to send a contact request.'
                      : 'Enter an account ID, then Search to preview the profile.'}
          </div>

          <div className="flex gap-1.5">
            <Button type="button" variant="secondary" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" onClick={() => setMode('menu')}>Back</Button>
            <Button
              type="submit"
              className="h-8 flex-1 rounded-[12px] px-3 text-[12px]"
              disabled={!contactNodeId.trim() || lookupState === 'searching' || addContactState === 'saving' || lookupRequestPending}
            >
              {lookupResult
                ? (lookupRequestPending ? 'Request pending' : addContactState === 'saving' ? 'Sending…' : 'Send request')
                : (lookupState === 'searching' ? 'Searching…' : 'Search')}
            </Button>
          </div>
        </form>
      ) : null}

      {mode === 'add-contact' && !onLookupContact ? (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            await submitAddContact(contactNodeId);
          }}
        >
          <div className="space-y-1.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[color:var(--utility-muted-text)]">Visible users</div>
            <div className="app-chat-create-option-list max-h-[min(10rem,calc(100vh-12rem))] space-y-1 overflow-auto pr-1">
              {visibleAddableContacts.length > 0 ? visibleAddableContacts.map((contact) => {
                const nodeId = contact.bridgePeerNodeId?.trim() ?? '';
                return (
                  <div key={contact.id} className="app-chat-create-list-item flex items-center justify-between gap-2 rounded-[12px] border px-2.5 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">{contact.name}</span>
                      <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">{contact.subtitle || contact.detail || nodeId}</span>
                    </span>
                    <Button
                      type="button"
                      className="h-7 shrink-0 rounded-[10px] px-2.5 text-[11px]"
                      disabled={addContactButtonDisabled(contact)}
                      onClick={() => {
                        void submitAddContact(nodeId);
                      }}
                    >
                      {addContactButtonLabel(contact)}
                    </Button>
                  </div>
                );
              }) : (
                <div className="app-chat-create-empty rounded-[12px] border px-2.5 py-2.5 text-[11px]">No visible users to request right now.</div>
              )}
            </div>
          </div>

          <input
            value={contactNodeId}
            onChange={(event) => {
              setContactNodeId(event.target.value);
              if (addContactState !== 'saving') setAddContactState('idle');
            }}
            placeholder={addContactPlaceholder ?? 'Bridge node ID, e.g. kd_...'}
            className="app-input-shell h-8 w-full rounded-[12px] px-2.5 text-[12px] outline-none"
          />
          <div className="min-h-4 text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]" aria-live="polite">
            {addContactState === 'sent'
              ? 'Request sent. They will appear in contacts after approval.'
              : addContactState === 'error'
                ? addContactError || 'Unable to send contact request.'
                : 'Paste a private/unlisted user node ID to request approval.'}
          </div>
          <div className="flex gap-1.5">
            <Button type="button" variant="secondary" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" onClick={() => setMode('menu')}>Back</Button>
            <Button type="submit" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" disabled={!onAddContact || !contactNodeId.trim() || addContactState === 'saving'}>
              {addContactState === 'saving' ? 'Sending…' : 'Send request'}
            </Button>
          </div>
        </form>
      ) : null}

      {mode === 'group' ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmitGroup) return;
            void onCreateGroup({ contactIds: selectedGroupContactIds, name: groupName.trim() || null });
            close();
          }}
        >
          <input
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder={defaultGroupName || 'Group name (optional)'}
            className="app-input-shell h-8 w-full rounded-[12px] px-2.5 text-[12px] outline-none"
          />
          <div className="app-chat-create-option-list max-h-[min(14.5rem,calc(100vh-10rem))] space-y-1 overflow-auto pr-1">
            {groupPersonOptions.length > 0 ? groupPersonOptions.map((option) => {
              const selected = selectedContactIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => toggleContact(option.id)}
                  className={cn(
                    'app-chat-create-list-item flex w-full items-center justify-between gap-2 rounded-[12px] border px-2.5 py-2 text-left transition',
                    selected && 'app-chat-create-list-item-selected',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">{option.label}</span>
                    <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">{option.detail}</span>
                  </span>
                  <span className={cn('app-chat-create-check grid h-[1.125rem] w-[1.125rem] shrink-0 place-items-center rounded-full border text-[9px]', selected && 'app-chat-create-check-selected')}>✓</span>
                </button>
              );
            }) : (
              <div className="app-chat-create-empty rounded-[12px] border px-2.5 py-2.5 text-[11px]">No approved contacts available.</div>
            )}
          </div>
          <div className="flex gap-1.5">
            <Button type="button" variant="secondary" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" onClick={() => setMode('menu')}>Back</Button>
            <Button type="submit" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" disabled={!canSubmitGroup}>
              {canSubmitGroup ? 'Create group' : 'Pick 2 people'}
            </Button>
          </div>
        </form>
      ) : null}
    </DialogCard>
  );
}
