import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { MoreHorizontal, ShieldCheck, UserMinus, UserPlus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { buildChatCreatePersonOptions, contactCanonicalIdentityRequest } from '@/features/chat/chatCreateFlows';
import type { Contact, ConversationParticipant, ParticipantSpaceViewModel } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

export type GroupDetailsDialogProps = {
  isOpen: boolean;
  space: ParticipantSpaceViewModel | null;
  contacts: Contact[];
  onClose: () => void;
  onRename: (sessionId: string, name: string) => Promise<void> | void;
  onAddMembers: (sessionId: string, contactIds: string[]) => Promise<void> | void;
  onRemoveMember: (sessionId: string, identityId: string) => Promise<void> | void;
  onSetAdmin: (sessionId: string, identityId: string, isAdmin: boolean) => Promise<void> | void;
};

function isHumanMember(participant: ConversationParticipant) {
  return participant.kind === 'human';
}

function isAdminMember(participant: ConversationParticipant) {
  return participant.role === 'self' || participant.role === 'admin';
}

function displayCreatedLabel(space: ParticipantSpaceViewModel) {
  const label = space.sessions[space.sessions.length - 1]?.updatedAtLabel ?? space.updatedAtLabel;
  return label ? `Created ${label}` : 'Created locally';
}

export function GroupDetailsDialog({
  isOpen,
  space,
  contacts,
  onClose,
  onRename,
  onAddMembers,
  onRemoveMember,
  onSetAdmin,
}: GroupDetailsDialogProps) {
  const session = space?.sessions[0] ?? null;
  const sessionId = session?.canonicalSessionId ?? session?.id ?? '';
  const allParticipants = session?.conversation.canonicalParticipants ?? space?.participants ?? [];
  const members = allParticipants.filter(isHumanMember);
  const memberIds = new Set(members.map((member) => member.id));
  const adminCount = members.filter(isAdminMember).length;
  const [nameDraft, setNameDraft] = useState(space?.title ?? '');
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const addOptions = useMemo(() => (
    buildChatCreatePersonOptions(contacts).filter((option) => {
      const identityId = contactCanonicalIdentityRequest(option.contact).id;
      return !memberIds.has(option.contact.id) && !memberIds.has(option.id) && !memberIds.has(identityId ?? '');
    })
  ), [contacts, memberIds]);

  if (!isOpen || !space || !sessionId) return null;

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    const name = nameDraft.trim();
    if (!name) return;
    void onRename(sessionId, name);
  };

  const toggleAddContact = (contactId: string) => {
    setSelectedContactIds((current) => (
      current.includes(contactId)
        ? current.filter((id) => id !== contactId)
        : [...current, contactId]
    ));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-[30rem] rounded-[24px] border border-white/10 bg-slate-950/95 p-4 text-white shadow-2xl shadow-slate-950/70">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 text-[15px] font-semibold text-white">
              <MoreHorizontal className="h-4 w-4 text-slate-400" /> Group details
            </div>
            <div className="mt-0.5 text-[11px] leading-4 text-slate-400">
              {displayCreatedLabel(space)} • {members.length} participants • {adminCount} admin{adminCount === 1 ? '' : 's'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[12px] text-slate-400 transition hover:bg-white/10 hover:text-white"
            aria-label="Close group details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form className="mb-4 flex gap-2" onSubmit={submitRename}>
          <input
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            placeholder="Group name"
            className="app-input-shell min-w-0 flex-1 rounded-[14px] px-3 py-2 text-[13px] text-white outline-none placeholder:text-slate-500"
          />
          <Button type="submit" className="rounded-[14px]" disabled={!nameDraft.trim()}>Rename</Button>
        </form>

        <div className="mb-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Participants</div>
          <div className="max-h-48 space-y-1 overflow-auto pr-1">
            {members.map((member) => {
              const admin = isAdminMember(member);
              const isLastAdmin = admin && adminCount <= 1;
              return (
                <div key={member.id} className="flex items-center gap-2 rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-white">{member.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-slate-500">
                      {admin ? <ShieldCheck className="h-3 w-3 text-emerald-300" /> : null}
                      {admin ? 'Admin' : 'Member'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={cn('rounded-[10px] px-2 py-1 text-[10px] transition', admin ? 'bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/18' : 'bg-white/[0.06] text-slate-300 hover:bg-white/[0.1]', isLastAdmin && 'cursor-not-allowed opacity-50')}
                    disabled={isLastAdmin}
                    onClick={() => { void onSetAdmin(sessionId, member.id, !admin); }}
                  >
                    {admin ? 'Demote' : 'Make admin'}
                  </button>
                  <button
                    type="button"
                    className={cn('grid h-7 w-7 place-items-center rounded-[10px] text-slate-400 transition hover:bg-rose-500/12 hover:text-rose-100', isLastAdmin && 'cursor-not-allowed opacity-50')}
                    disabled={isLastAdmin}
                    aria-label={`Remove ${member.name}`}
                    onClick={() => { void onRemoveMember(sessionId, member.id); }}
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            <UserPlus className="h-3.5 w-3.5" /> Add people
          </div>
          <div className="max-h-36 space-y-1 overflow-auto pr-1">
            {addOptions.length > 0 ? addOptions.map((option) => {
              const selected = selectedContactIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => toggleAddContact(option.id)}
                  className={cn('flex w-full items-center justify-between gap-2 rounded-[12px] border px-3 py-2 text-left text-[12px] transition', selected ? 'border-emerald-400/35 bg-emerald-400/10 text-white' : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.07]')}
                >
                  <span>{option.label}</span>
                  <span className={selected ? 'text-emerald-200' : 'text-slate-600'}>✓</span>
                </button>
              );
            }) : (
              <div className="rounded-[12px] border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-slate-500">No additional people contacts available.</div>
            )}
          </div>
          <Button
            type="button"
            className="mt-2 w-full rounded-[14px]"
            disabled={selectedContactIds.length === 0}
            onClick={() => {
              void onAddMembers(sessionId, selectedContactIds);
              setSelectedContactIds([]);
            }}
          >
            Add selected people
          </Button>
        </div>
      </div>
    </div>
  );
}
