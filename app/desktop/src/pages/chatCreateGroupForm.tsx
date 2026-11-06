import { useMemo, useState } from 'react';
import { Check, Copy, Link2, LoaderCircle, Share } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CopyToast } from '@/components/ui/copyFeedback';
import { ErrorLine, withoutTryAgain } from '@/components/ui/errors';
import { useCopyFeedback } from '@/components/ui/useCopyFeedback';
import type { CreateChatGroupRequest } from '@/app/kordiShellSlots.types';
import type { CloudGroupInvitation, CloudGroupInvitationCreateInput } from '@/features/cloud/authClient';
import { buildChatCreateGroupPersonOptions } from '@/features/chat/chatCreateFlows';
import { groupCreationErrorMessage, groupInvitationLinkErrorMessage, groupNameIsValid, invitationExpiryLabel as expiryLabel } from '@/features/chat/groupCreateCopy';
import type { Contact } from '@/kordi-app/types';
import { GroupAvatarEditor } from '@/kordi-app/components/GroupAvatarEditor';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';

export type ChatCreateGroupFormProps = {
  contacts: Contact[];
  onCreateGroup: (request: CreateChatGroupRequest) => Promise<string | void> | void;
  /** Present when this account can create group invitation links. */
  onCreateGroupInvitation?: (input: CloudGroupInvitationCreateInput) => Promise<CloudGroupInvitation>;
  onBack: () => void;
  onDone: () => void;
  /** Called with the group's name when its link is showing. */
  onLinkShown?: (title: string) => void;
};

type SharedLink = { url: string; expiresAt: string };


/** Start group: a dense contact picker, plus a link for people who are not on Kordi yet. */
export function ChatCreateGroupForm({ contacts, onCreateGroup, onCreateGroupInvitation, onBack, onDone, onLinkShown }: ChatCreateGroupFormProps) {
  const options = useMemo(() => buildChatCreateGroupPersonOptions(contacts), [contacts]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which action a "Try again" on the error line repeats.
  const [errorRetry, setErrorRetry] = useState<'create' | 'link' | null>(null);
  const [busy, setBusy] = useState<'create' | 'link' | null>(null);
  const [link, setLink] = useState<SharedLink | null>(null);
  // A group created for a link whose invitation then failed: retrying reuses it.
  const [linkGroup, setLinkGroup] = useState<{ sessionId: string; title: string } | null>(null);
  const { copied, copy: copyText } = useCopyFeedback();

  const selected = options.filter((option) => selectedIds.includes(option.id));
  const contactIds = selected.map((option) => option.id);
  const trimmedName = name.trim();
  const nameIsValid = groupNameIsValid(name);
  const toggle = (id: string) => setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const request = (inviteLink: boolean): CreateChatGroupRequest => ({ contactIds, name: trimmedName, avatarDataUrl, ...(inviteLink ? { inviteLink } : {}) });
  const create = async () => {
    if (busy || !nameIsValid) return;
    // The group already exists when only its link failed: finish with it.
    if (linkGroup) { onDone(); return; }
    setBusy('create'); setError(null); setErrorRetry(null);
    try { await onCreateGroup(request(false)); onDone(); }
    catch (caught) { setError(groupCreationErrorMessage(caught)); setErrorRetry('create'); }
    finally { setBusy(null); }
  };
  const inviteWithLink = async () => {
    if (!onCreateGroupInvitation || busy || !nameIsValid) return;
    setBusy('link'); setError(null); setErrorRetry(null);
    let group = linkGroup;
    try {
      if (!group) {
        const sessionId = await onCreateGroup(request(true));
        if (!sessionId) throw new Error('Could not create this group.');
        group = { sessionId, title: trimmedName };
        setLinkGroup(group);
      }
    } catch (caught) {
      setError(groupCreationErrorMessage(caught));
      setErrorRetry('link');
      setBusy(null);
      return;
    }
    try {
      const invitation = await onCreateGroupInvitation({ groupId: group.sessionId, groupSpaceId: group.sessionId, groupTitle: group.title });
      setLink({ url: invitation.inviteUrl, expiresAt: invitation.expiresAt });
      onLinkShown?.(group.title);
    } catch (caught) {
      setError(groupInvitationLinkErrorMessage(caught, { asCreator: true }));
      setErrorRetry('link');
    } finally { setBusy(null); }
  };
  const copy = async () => {
    if (!link) return;
    setErrorRetry(null);
    try { await copyText(link.url); setError(null); }
    catch { setError("Couldn't copy the link. Select it and copy it."); }
  };
  // Offer "Try again" only for a plain retry message, not "Try again later" or a fix-it hint.
  const retryable = error !== null && errorRetry !== null && withoutTryAgain(error) !== error;
  const errorLine = error ? (
    <ErrorLine
      className="mt-0"
      action={retryable ? {
        label: 'Try again',
        disabled: Boolean(busy),
        onClick: () => { void (errorRetry === 'link' ? inviteWithLink() : create()); },
      } : null}
    >
      {retryable ? withoutTryAgain(error) : error}
    </ErrorLine>
  ) : null;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  if (link) {
    return (
      <div className="app-chat-create-group">
        <div className="flex gap-1.5">
          <input
            aria-label="Group invitation link"
            readOnly
            autoFocus
            value={link.url}
            onFocus={(event) => event.currentTarget.select()}
            className="app-input-shell h-8 min-w-0 flex-1 rounded-[8px] px-2.5 text-[11px] outline-none"
          />
          <button type="button" className="app-chat-create-icon-button" aria-label={copied ? 'Link copied' : 'Copy link'} title={copied ? 'Copied' : 'Copy link'} onClick={() => { void copy(); }}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
          {canShare ? (
            <button type="button" className="app-chat-create-icon-button" aria-label="Share invitation link" title="Share" onClick={() => { void navigator.share({ url: link.url }).catch(() => {}); }}>
              <Share aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <p className="app-chat-create-group-note">{expiryLabel(link.expiresAt)}</p>
        {errorLine}
        <Button type="button" className="h-8 w-full rounded-[8px] text-[12px]" onClick={onDone}>Done</Button>
        <CopyToast visible={copied} />
      </div>
    );
  }

  return (
    <form className="app-chat-create-group" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="flex items-center gap-2">
        <GroupAvatarEditor
          avatars={selected.map((person) => ({ kind: 'human', seed: person.avatarSeed || person.id, imageUrl: person.profileImageUrl }))}
          imageUrl={avatarDataUrl}
          name={name || 'Group'}
          disabled={Boolean(busy)}
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
        {onCreateGroupInvitation ? (
          <button type="button" disabled={Boolean(busy) || !nameIsValid} onClick={() => { void inviteWithLink(); }}>
            {busy === 'link' ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Link2 aria-hidden="true" />}
            <span>Invite with a link</span>
          </button>
        ) : null}
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
        <Button type="submit" className="h-8 flex-1 rounded-[8px] px-3 text-[12px]" disabled={Boolean(busy) || !nameIsValid}>
          {busy === 'create' ? 'Creating…' : 'Create group'}
        </Button>
      </div>
    </form>
  );
}
