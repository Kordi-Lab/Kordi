import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorLine, withoutTryAgain } from '@/components/ui/errors';
import type { CreateChatGroupRequest } from '@/app/kordiShellSlots.types';
import { buildChatCreateGroupPersonOptions } from '@/features/chat/chatCreateFlows';
import { groupCreationErrorMessage, groupNameIsValid } from '@/features/chat/groupCreateCopy';
import type { Contact } from '@/kordi-app/types';
import { GroupAvatarEditor } from '@/kordi-app/components/GroupAvatarEditor';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';
import type { GroupInviteHandle } from './useGroupInviteAutoCopy';

export type ChatCreateGroupFormProps = {
  contacts: Contact[];
  onCreateGroup: (request: CreateChatGroupRequest) => Promise<string | void> | void;
  /** Starts the new group's invitation link during the Create group click; null when links are unavailable. */
  onStartInvite?: () => GroupInviteHandle | null;
  onBack: () => void;
  onDone: () => void;
};

/** Start group: a name, an optional photo and a dense contact picker. Its
 * invitation link is made and copied once the group exists. */
export function ChatCreateGroupForm({ contacts, onCreateGroup, onStartInvite, onBack, onDone }: ChatCreateGroupFormProps) {
  const options = useMemo(() => buildChatCreateGroupPersonOptions(contacts), [contacts]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = options.filter((option) => selectedIds.includes(option.id));
  const trimmedName = name.trim();
  const nameIsValid = groupNameIsValid(name);
  const toggle = (id: string) => setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const create = async () => {
    if (busy || !nameIsValid) return;
    // Started inside the click, so the link can reach the clipboard later.
    const invite = onStartInvite?.() ?? null;
    setBusy(true); setError(null);
    try {
      const sessionId = await onCreateGroup({ contactIds: selected.map((option) => option.id), name: trimmedName, avatarDataUrl });
      if (sessionId) invite?.created(sessionId, trimmedName);
      else invite?.cancel();
      onDone();
    } catch (caught) {
      invite?.cancel();
      setError(groupCreationErrorMessage(caught));
    } finally { setBusy(false); }
  };
  // Offer "Try again" only for a plain retry message, not "Try again later" or a fix-it hint.
  const retryable = error !== null && withoutTryAgain(error) !== error;
  const errorLine = error ? (
    <ErrorLine
      className="mt-0"
      action={retryable ? { label: 'Try again', disabled: busy, onClick: () => { void create(); } } : null}
    >
      {retryable ? withoutTryAgain(error) : error}
    </ErrorLine>
  ) : null;

  return (
    <form className="app-chat-create-group" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="flex items-center gap-2">
        <GroupAvatarEditor
          avatars={selected.map((person) => ({ kind: 'human', seed: person.avatarSeed || person.id, imageUrl: person.profileImageUrl }))}
          imageUrl={avatarDataUrl}
          name={name || 'Group'}
          disabled={busy}
          avatarClassName="h-8 w-8 app-chat-create-group-avatar"
          onUpload={(dataUrl) => setAvatarDataUrl(dataUrl)}
          onRemove={() => setAvatarDataUrl(null)}
        />
        <input
          aria-label="Group name"
          value={name}
          autoFocus
          required
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          placeholder="Group name"
          className="app-input-shell h-8 min-w-0 flex-1 rounded-[8px] px-2.5 text-[12px] outline-none"
        />
      </div>
      {errorLine}
      <div className="app-dense-menu-items app-chat-create-option-list max-h-[min(15rem,calc(100vh-12rem))] overflow-auto" role="group" aria-label="People">
        {options.length > 0 ? options.map((option) => {
          const isSelected = selectedIds.includes(option.id);
          return (
            <button key={option.id} type="button" aria-pressed={isSelected} onClick={() => toggle(option.id)}>
              <IdentityAvatar kind="human" seed={option.avatarSeed || option.id} name={option.label} imageUrl={option.profileImageUrl ?? null} className="app-chat-create-row-avatar" />
              <span className="truncate">{option.label}</span>
              <span aria-hidden="true" className={cn('app-chat-create-check', isSelected && 'app-chat-create-check-selected')}>{isSelected ? <Check /> : null}</span>
            </button>
          );
        }) : <p className="app-chat-create-group-note">No approved contacts available.</p>}
      </div>
      <div className="flex gap-1.5">
        <Button type="button" variant="quiet" className="h-8 flex-1 rounded-[8px] px-3 text-[12px]" onClick={onBack}>Back</Button>
        <Button type="submit" className="h-8 flex-1 rounded-[8px] px-3 text-[12px]" disabled={busy || !nameIsValid}>
          {busy ? 'Creating…' : 'Create group'}
        </Button>
      </div>
    </form>
  );
}
