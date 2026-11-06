import type { ChatCreatePopoverAnchor } from './chatCreateGeometry';
import { ChatCreateHeader, ChatCreateMenuHeader, ChatCreateMenuRow, ChatCreatePopover } from './chatCreatePopover';
export type { ChatCreatePopoverAnchor } from './chatCreateGeometry';
import { useEffect, useId, useMemo, useState } from 'react';
import { Bot, MessageSquare, UserPlus, Users } from 'lucide-react';

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
import { GroupAvatarEditor } from '@/kordi-app/components/GroupAvatarEditor';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { formatKordiHandle } from '@/features/cloud/kordiId';

export type AddContactLookupResult = {
  accountId: string;
  kordiId?: string | null;
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
  /** Override the placeholder shown in the Add-contacts input. */
  addContactPlaceholder?: string;
  initialMode?: CreateMode;
  anchorRect?: ChatCreatePopoverAnchor | null;
};

export type ChatCreateMode = 'menu' | 'person' | 'agent' | 'group' | 'add-contact';
type CreateMode = ChatCreateMode;
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
  const titleId = useId();
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [groupAvatarDataUrl, setGroupAvatarDataUrl] = useState<string | null>(null);
  const [groupCreateError, setGroupCreateError] = useState<string | null>(null);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
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
  const visibleAddableContacts = useMemo(() => addableContacts.filter((contact) => contact.sourceParticipantId?.trim()), [addableContacts]);

  useEffect(() => {
    if (!isOpen) return;
    // Mirrors close()'s resets so every open (or a live initialMode retarget
    // while already open) starts clean regardless of how the previous
    // session ended, without needing a remounting `key` on this component
    // (that key tore the whole dialog down and replayed its enter animation
    // on every open and close, and made an exit animation impossible -- see
    // WorkspaceSidebar.tsx).
    setMode(initialMode);
    setSelectedContactIds([]);
    setGroupName('');
    setGroupAvatarDataUrl(null);
    setGroupCreateError(null);
    setContactNodeId('');
    setAddContactState('idle');
    setAddContactError('');
    setRequestingContactNodeId(null);
    setRequestedContactNodeIds([]);
    setLookupState('idle');
    setLookupError('');
    setLookupResult(null);
  }, [initialMode, isOpen]);

  const selectedPeople = groupPersonOptions.filter((option) => selectedContactIds.includes(option.id));
  const selectedGroupContactIds = selectedPeople.map((option) => option.id);
  const defaultGroupName = groupDefaultName(selectedPeople.map((option) => option.label));
  const canSubmitGroup = canCreateGroup(selectedGroupContactIds);
  const addContactSubtitle = 'Send an approval request by Kordi ID.';
  const lookupRequestPending = Boolean(lookupResult && (lookupResult.isRequestPending || requestedContactNodeIds.includes(lookupResult.accountId)));

  if (!isOpen) return null;

  const close = () => {
    setMode(initialMode);
    setSelectedContactIds([]);
    setGroupName('');
    setGroupAvatarDataUrl(null);
    setGroupCreateError(null);
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
    const nodeId = contact.sourceParticipantId?.trim() ?? '';
    const status = contact.contactStatus?.trim().toLowerCase() ?? '';
    const direction = contact.contactRequestDirection?.trim().toLowerCase() ?? '';
    if (requestingContactNodeId === nodeId) return 'Sending…';
    if (requestedContactNodeIds.includes(nodeId)) return 'Requested';
    if (status === 'pending' && direction === 'outgoing') return 'Pending';
    if (status === 'pending' && direction === 'incoming') return 'Review';
    return 'Request';
  };

  const addContactButtonDisabled = (contact: Contact) => {
    const nodeId = contact.sourceParticipantId?.trim() ?? '';
    const status = contact.contactStatus?.trim().toLowerCase() ?? '';
    const direction = contact.contactRequestDirection?.trim().toLowerCase() ?? '';
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
    <ChatCreatePopover onClose={close} anchorRect={anchorRect} dense={mode === 'menu'} titleId={titleId} focusKey={mode}>
      {mode === 'menu' ? (
        <>
          <ChatCreateMenuHeader title="Start a chat" titleId={titleId} />
          <div className="app-dense-menu-items">
            <ChatCreateMenuRow icon={MessageSquare} title="Chat with contact" onClick={() => setMode('person')} />
            <ChatCreateMenuRow icon={Bot} title="Chat with agent" onClick={() => setMode('agent')} />
            <ChatCreateMenuRow icon={Users} title="Start group" onClick={() => setMode('group')} />
            <ChatCreateMenuRow icon={UserPlus} title="Add contacts" onClick={() => setMode('add-contact')} />
          </div>
        </>
      ) : (
        <ChatCreateHeader
          title={mode === 'person' ? 'Chat with contact' : mode === 'agent' ? 'Chat with agent' : mode === 'add-contact' ? 'Add contact' : 'Start group'}
          titleId={titleId}
          subtitle={mode === 'group' ? 'Select at least 2 contacts.' : mode === 'add-contact' ? addContactSubtitle : undefined}
        />
      )}

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
          <Button type="button" variant="quiet" className="h-8 w-full rounded-[12px] text-[12px]" onClick={() => setMode('menu')}>Back</Button>
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
                className="app-chat-create-list-item flex w-full items-center gap-2 rounded-[12px] border px-2.5 py-2 text-left transition"
              >
                <IdentityAvatar
                  kind="agent"
                  seed={option.agent.avatarSeed || option.agent.cloudAgentId || option.agent.id}
                  name={option.agent.name}
                  imageUrl={option.agent.profileImageUrl ?? null}
                  avatarKey={option.agent.cloudAgentId || option.agent.id}
                  className="h-7 w-7"
                />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">{option.label}</span>
                  <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">{option.detail}</span>
                </span>
              </button>
            )) : (
              <div className="app-chat-create-empty rounded-[12px] border px-2.5 py-2.5 text-[11px]">No agents available.</div>
            )}
          </div>
          {initialMode === 'menu' ? (
            <Button type="button" variant="quiet" className="h-8 w-full rounded-[12px] text-[12px]" onClick={() => setMode('menu')}>Back</Button>
          ) : null}
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
            placeholder={addContactPlaceholder ?? 'Kordi ID, e.g. @482731906'}
            className="app-input-shell h-8 w-full rounded-[12px] px-2.5 text-[12px] outline-none"
            autoFocus
          />

          {lookupResult ? (
            <div className="app-chat-create-list-item flex items-center justify-between gap-2 rounded-[12px] border px-2.5 py-2">
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">
                  {lookupResult.displayName || 'Kordi user'}
                </span>
                <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">
                  {formatKordiHandle(lookupResult.kordiId) || 'Kordi ID unavailable'}
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
              ? 'Request sent. It stays under Requests in Contacts until they respond.'
              : addContactState === 'pending' || lookupRequestPending
                ? 'Request pending. It stays under Requests in Contacts until they respond.'
                : lookupState === 'error'
                  ? lookupError || 'Lookup failed.'
                  : addContactState === 'error'
                    ? addContactError || 'Unable to send contact request.'
                    : lookupResult
                      ? 'Tap Add to send a contact request.'
                      : 'Enter a Kordi ID, then Search to preview the profile.'}
          </div>

          <div className="flex gap-1.5">
            <Button type="button" variant="quiet" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" onClick={() => setMode('menu')}>Back</Button>
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
                const nodeId = contact.sourceParticipantId?.trim() ?? '';
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
            placeholder={addContactPlaceholder ?? 'Kordi ID'}
            className="app-input-shell h-8 w-full rounded-[12px] px-2.5 text-[12px] outline-none"
          />
          <div className="min-h-4 text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]" aria-live="polite">
            {addContactState === 'sent'
              ? 'Request sent. They will appear in contacts after approval.'
              : addContactState === 'error'
                ? addContactError || 'Unable to send contact request.'
                : 'Paste a Kordi ID to request approval.'}
          </div>
          <div className="flex gap-1.5">
            <Button type="button" variant="quiet" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" onClick={() => setMode('menu')}>Back</Button>
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
            if (!canSubmitGroup || isCreatingGroup) return;
            setIsCreatingGroup(true); setGroupCreateError(null);
            void Promise.resolve().then(() => onCreateGroup({ contactIds: selectedGroupContactIds, name: groupName.trim() || null, avatarDataUrl: groupAvatarDataUrl }))
              .then(close).catch((error: unknown) => setGroupCreateError(error instanceof Error ? error.message : 'Could not create this group.'))
              .finally(() => setIsCreatingGroup(false));
          }}
        >
          <div className="flex justify-center pb-1">
            <GroupAvatarEditor avatars={selectedPeople.map((person) => ({ kind: 'human', seed: person.avatarSeed || person.id, imageUrl: person.profileImageUrl }))} imageUrl={groupAvatarDataUrl} name={groupName || 'Group'} disabled={isCreatingGroup} onUpload={(dataUrl) => setGroupAvatarDataUrl(dataUrl)} onRemove={() => setGroupAvatarDataUrl(null)} />
          </div>
          {groupCreateError ? <div role="alert" className="app-error-text text-[11px]">{groupCreateError}</div> : null}
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
            <Button type="button" variant="quiet" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" onClick={() => setMode('menu')}>Back</Button>
            <Button type="submit" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" disabled={isCreatingGroup || !canSubmitGroup}>
              {isCreatingGroup ? 'Creating…' : canSubmitGroup ? 'Create group' : 'Pick 2 people'}
            </Button>
          </div>
        </form>
      ) : null}
    </ChatCreatePopover>
  );
}
