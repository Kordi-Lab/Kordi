import { useMemo, useState } from 'react';
import { Check, Copy, Link2, LoaderCircle, Share } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { CreateChatGroupRequest } from '@/app/kordiShellSlots.types';
import type { CloudGroupInvitation, CloudGroupInvitationCreateInput } from '@/features/cloud/authClient';
import { buildChatCreateGroupPersonOptions, canCreateGroup, groupDefaultName } from '@/features/chat/chatCreateFlows';
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

function expiryLabel(expiresAt: string) {
  const remaining = Date.parse(expiresAt) - Date.now();
  const days = Number.isFinite(remaining) ? Math.max(1, Math.round(remaining / 86_400_000)) : 7;
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Start group: a dense contact picker, plus a link for people who are not on Kordi yet. */
export function ChatCreateGroupForm({ contacts, onCreateGroup, onCreateGroupInvitation, onBack, onDone, onLinkShown }: ChatCreateGroupFormProps) {
  const options = useMemo(() => buildChatCreateGroupPersonOptions(contacts), [contacts]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'link' | null>(null);
  const [link, setLink] = useState<SharedLink | null>(null);
  // A group created for a link whose invitation then failed: retrying reuses it.
  const [linkGroup, setLinkGroup] = useState<{ sessionId: string; title: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const selected = options.filter((option) => selectedIds.includes(option.id));
  const contactIds = selected.map((option) => option.id);
  const defaultName = groupDefaultName(selected.map((option) => option.label));
  const canSubmit = canCreateGroup(contactIds);
  const toggle = (id: string) => setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const request = (inviteLink: boolean): CreateChatGroupRequest => ({ contactIds, name: name.trim() || null, avatarDataUrl, ...(inviteLink ? { inviteLink } : {}) });
  const create = async () => {
    if (!canSubmit || busy) return;
    setBusy('create'); setError(null);
    try { await onCreateGroup(request(false)); onDone(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not create this group.'); }
    finally { setBusy(null); }
  };
  const inviteWithLink = async () => {
    if (!onCreateGroupInvitation || (contactIds.length === 0 && !linkGroup) || busy) return;
    setBusy('link'); setError(null);
    try {
      let group = linkGroup;
      if (!group) {
        const sessionId = await onCreateGroup(request(true));
        if (!sessionId) throw new Error('Could not create this group.');
        group = { sessionId, title: name.trim() || defaultName || 'Group' };
        setLinkGroup(group);
      }
      const invitation = await onCreateGroupInvitation({ groupId: group.sessionId, groupSpaceId: group.sessionId, groupTitle: group.title });
      setLink({ url: invitation.inviteUrl, expiresAt: invitation.expiresAt });
      onLinkShown?.(group.title);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the link.');
    } finally { setBusy(null); }
  };
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setCopied(true); setError(null); }
    catch { setError('Could not copy the link. Select it and copy it.'); }
  };
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
          <button type="button" className="app-chat-create-icon-button" aria-label={copied ? 'Invitation link copied' : 'Copy invitation link'} title={copied ? 'Copied' : 'Copy link'} onClick={() => { void copy(); }}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
          {canShare ? (
            <button type="button" className="app-chat-create-icon-button" aria-label="Share invitation link" title="Share" onClick={() => { void navigator.share({ url: link.url }).catch(() => {}); }}>
              <Share aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <p className="app-chat-create-group-note">{expiryLabel(link.expiresAt)}</p>
        {error ? <p role="alert" className="app-error-text text-[11px]">{error}</p> : null}
        <Button type="button" className="h-8 w-full rounded-[8px] text-[12px]" onClick={onDone}>Done</Button>
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
          onChange={(event) => setName(event.target.value)}
          placeholder={defaultName || 'Group name (optional)'}
          className="app-input-shell h-8 min-w-0 flex-1 rounded-[8px] px-2.5 text-[12px] outline-none"
        />
      </div>
      {error ? <p role="alert" className="app-error-text text-[11px]">{error}</p> : null}
      <div className="app-dense-menu-items app-chat-create-option-list max-h-[min(15rem,calc(100vh-12rem))] overflow-auto" role="group" aria-label="People">
        {onCreateGroupInvitation ? (
          <button type="button" disabled={(contactIds.length === 0 && !linkGroup) || Boolean(busy)} onClick={() => { void inviteWithLink(); }}>
            {busy === 'link' ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Link2 aria-hidden="true" />}
            <span>Invite with a link</span>
            {contactIds.length === 0 && !linkGroup ? <span className="app-chat-create-row-meta">Pick 1 person</span> : null}
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
        <Button type="submit" className="h-8 flex-1 rounded-[8px] px-3 text-[12px]" disabled={Boolean(busy) || !canSubmit}>
          {busy === 'create' ? 'Creating…' : canSubmit ? 'Create group' : 'Pick 2 people'}
        </Button>
      </div>
    </form>
  );
}
