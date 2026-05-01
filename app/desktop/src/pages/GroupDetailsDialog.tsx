import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { MoreHorizontal, ShieldCheck, UserMinus, UserPlus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { buildChatCreatePersonOptions, contactCanonicalIdentityRequest } from '@/features/chat/chatCreateFlows';
import type { Contact, ConversationParticipant, ParticipantSpaceViewModel } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

export type GroupManagementPopoverAnchor = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type GroupDetailsDialogProps = {
  isOpen: boolean;
  space: ParticipantSpaceViewModel | null;
  contacts: Contact[];
  onClose: () => void;
  onRename: (sessionId: string, name: string) => Promise<void> | void;
  onAddMembers: (sessionId: string, contactIds: string[]) => Promise<void> | void;
  onRemoveMember: (sessionId: string, identityId: string) => Promise<void> | void;
  onSetAdmin: (sessionId: string, identityId: string, isAdmin: boolean) => Promise<void> | void;
  anchorRect?: GroupManagementPopoverAnchor | null;
};

type PopoverPlacement = 'right' | 'left' | 'floating';
type GroupPopoverStyle = CSSProperties & {
  '--app-group-management-enter-x'?: string;
  '--app-group-management-origin'?: string;
};

type GroupPopoverGeometry = {
  style: GroupPopoverStyle;
  arrowStyle: CSSProperties;
  placement: PopoverPlacement;
};

function groupManagementGeometry(anchorRect?: GroupManagementPopoverAnchor | null): GroupPopoverGeometry {
  const width = 416;
  const gap = 10;
  const margin = 10;

  if (!anchorRect) {
    return {
      placement: 'floating',
      arrowStyle: { top: 22 },
      style: {
        left: 318,
        top: 82,
        '--app-group-management-enter-x': '-6px',
        '--app-group-management-origin': 'left 26px',
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
  const top = Math.min(Math.max(margin, anchorRect.top - 8), Math.max(margin, viewportHeight - 600));
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;
  const arrowTop = Math.min(Math.max(22, anchorCenterY - top - 6), 70);

  return {
    placement,
    arrowStyle: { top: arrowTop },
    style: {
      left,
      top,
      '--app-group-management-enter-x': placement === 'right' ? '-8px' : '8px',
      '--app-group-management-origin': placement === 'right' ? 'left 26px' : 'right 26px',
    },
  };
}

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
  anchorRect = null,
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

  useEffect(() => {
    if (!isOpen) return;
    setNameDraft(space?.title ?? '');
    setSelectedContactIds([]);
  }, [isOpen, space?.id, space?.title]);

  if (!isOpen || !space || !sessionId) return null;

  const { style, arrowStyle, placement } = groupManagementGeometry(anchorRect);

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
    <>
      <button
        type="button"
        className="fixed inset-0 z-50 cursor-default bg-transparent"
        aria-label="Close group management"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Group management"
        data-group-management-surface="popover"
        data-popover-placement={placement}
        className="app-frosted-popover app-group-management-popover app-group-management-popover-enter fixed z-[60] w-[min(26rem,calc(100vw-1.25rem))] overflow-hidden rounded-[20px] p-3 backdrop-blur-2xl backdrop-saturate-150"
        style={style}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {placement !== 'floating' ? (
          <div
            aria-hidden="true"
            className={cn(
              'app-group-management-popover-arrow absolute h-3.5 w-3.5 rotate-45',
              placement === 'right' ? '-left-[0.45rem]' : '-right-[0.45rem]',
            )}
            style={arrowStyle}
          />
        ) : null}

        <div className="relative flex max-h-[min(36rem,calc(100vh-1.5rem))] flex-col">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 text-[14px] font-semibold text-[color:var(--utility-foreground)]">
                <MoreHorizontal className="h-4 w-4 text-[color:var(--utility-muted-text)]" /> Group management
              </div>
              <div className="mt-0.5 text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">
                {displayCreatedLabel(space)} • {members.length} participants • {adminCount} admin{adminCount === 1 ? '' : 's'}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="app-group-management-close grid h-7 w-7 shrink-0 place-items-center rounded-[10px] transition"
              aria-label="Close group management"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <form className="mb-3 flex gap-2" onSubmit={submitRename}>
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              placeholder="Group name"
              className="app-input-shell min-w-0 flex-1 rounded-[12px] px-3 py-2 text-[12px] outline-none"
            />
            <Button type="submit" className="h-9 rounded-[12px] px-3 text-[12px]" disabled={!nameDraft.trim()}>Rename</Button>
          </form>

          <div className="min-h-0 overflow-auto pr-1">
            <div className="mb-3">
              <div className="app-group-management-section-label mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em]">Participants</div>
              <div className="space-y-1">
                {members.map((member) => {
                  const admin = isAdminMember(member);
                  const isLastAdmin = admin && adminCount <= 1;
                  return (
                    <div key={member.id} className="app-group-management-member-row flex items-center gap-2 rounded-[13px] border px-2.5 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium text-[color:var(--utility-foreground)]">{member.name}</div>
                        <div className="mt-px flex items-center gap-1.5 text-[10.5px] text-[color:var(--utility-muted-text)]">
                          {admin ? <ShieldCheck className="h-3 w-3 text-emerald-300" /> : null}
                          {admin ? 'Admin' : 'Member'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={cn('app-group-management-admin-button rounded-[10px] px-2 py-1 text-[10px] transition', admin && 'app-group-management-admin-button-active', isLastAdmin && 'cursor-not-allowed opacity-50')}
                        disabled={isLastAdmin}
                        onClick={() => { void onSetAdmin(sessionId, member.id, !admin); }}
                      >
                        {admin ? 'Demote' : 'Make admin'}
                      </button>
                      <button
                        type="button"
                        className={cn('app-group-management-remove-button grid h-7 w-7 place-items-center rounded-[10px] transition', isLastAdmin && 'cursor-not-allowed opacity-50')}
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
              <div className="app-group-management-section-label mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em]">
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
                      className={cn('app-group-management-add-row flex w-full items-center justify-between gap-2 rounded-[12px] border px-2.5 py-2 text-left text-[12px] transition', selected && 'app-group-management-add-row-selected')}
                    >
                      <span>{option.label}</span>
                      <span className={selected ? 'text-emerald-300' : 'text-[color:var(--utility-muted-text)]'}>✓</span>
                    </button>
                  );
                }) : (
                  <div className="app-group-management-empty rounded-[12px] border px-2.5 py-2 text-[12px]">No additional people contacts available.</div>
                )}
              </div>
              <Button
                type="button"
                className="mt-2 h-9 w-full rounded-[12px] text-[12px]"
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
      </div>
    </>
  );
}
