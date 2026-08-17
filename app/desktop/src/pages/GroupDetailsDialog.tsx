import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  FormEvent,
} from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Star,
  UserMinus,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type {
  CloudGroupInvitation,
  CloudGroupInvitationCreateInput,
  CloudGroupInvitationSummary,
} from '@/features/cloud/authClient';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import {
  adminIdentityIdsFromMetadata,
  buildChatCreateGroupPersonOptions,
  contactCanonicalIdentityRequest,
  participantSpaceCanonicalMembershipSessionIds,
  participantSpaceCanonicalSessionIds,
} from '@/features/chat/chatCreateFlows';
import type { Contact, ConversationParticipant, ParticipantSpaceViewModel } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { GroupProfileHeader } from '@/pages/GroupProfileHeader';
import { GroupInvitationSharePanel } from '@/pages/GroupInvitationSharePanel';
import {
  COLLAPSED_MEMBER_GRID_ITEMS,
  GROUP_MANAGEMENT_FOCUSABLE_SELECTOR,
  groupManagementGeometry,
  handleGridArrowNavigation,
  type GroupManagementPopoverAnchor,
  type ViewportSize,
} from '@/pages/groupManagementGeometry';
import { MemberContactProfileContent } from '@/pages/MemberContactProfilePopover';

export type { GroupManagementPopoverAnchor } from '@/pages/groupManagementGeometry';

export type GroupDetailsDialogProps = {
  isOpen: boolean;
  space: ParticipantSpaceViewModel | null;
  contacts: Contact[];
  currentAccountId?: string | null;
  onClose: () => void;
  onRename: (sessionIds: string[], name: string) => Promise<void> | void;
  onAddMembers: (sessionIds: string[], contactIds: string[]) => Promise<void> | void;
  onRemoveMember: (sessionIds: string[], identityId: string) => Promise<void> | void;
  onSetAdmin: (sessionIds: string[], identityId: string, isAdmin: boolean) => Promise<void> | void;
  onAddContact?: (accountId: string) => Promise<void> | void;
  onCreateGroupInvitation?: (
    input: CloudGroupInvitationCreateInput,
  ) => Promise<CloudGroupInvitation>;
  onListGroupInvitations?: (groupSpaceId: string) => Promise<CloudGroupInvitationSummary[]>;
  onRevokeGroupInvitation?: (invitationId: string) => Promise<void>;
  onMessageContact?: (contact: Contact) => Promise<void> | void;
  anchorRect?: GroupManagementPopoverAnchor | null;
};

function isHumanMember(participant: ConversationParticipant) {
  return participant.kind === 'human';
}

function isSelfMember(participant: ConversationParticipant) {
  return participant.role === 'self' || (participant.kind === 'human' && participant.source === 'local');
}

function fallbackRoleAdminIds(members: ConversationParticipant[]) {
  return members.filter((member) => member.role === 'admin').map((member) => member.id);
}

function groupAdminIds(space: ParticipantSpaceViewModel | null, members: ConversationParticipant[]) {
  const activeSession = space?.sessions[0] ?? null;
  if (space?.groupAdminIdentityIds?.length) {
    return new Set(space.groupAdminIdentityIds.map((id) => id.trim()).filter(Boolean));
  }
  const metadataAdminIds = adminIdentityIdsFromMetadata(activeSession?.conversation.metadata);
  const uniqueMetadataAdminIds = [...new Set(metadataAdminIds.map((id) => id.trim()).filter(Boolean))];
  const creatorId = space?.groupCreatorIdentityId?.trim()
    || activeSession?.conversation.canonicalCreatedByIdentityId?.trim()
    || '';
  if (uniqueMetadataAdminIds.length > 0) return new Set([creatorId, ...uniqueMetadataAdminIds].filter(Boolean));
  const roleAdminIds = fallbackRoleAdminIds(members);
  if (roleAdminIds.length > 0) return new Set([creatorId, ...roleAdminIds].filter(Boolean));
  return new Set(creatorId ? [creatorId] : []);
}

function memberStableId(member: ConversationParticipant) {
  return member.humanId?.trim()
    || member.sourceIdentityId?.trim()
    || member.id.trim();
}

function identityKeyVariants(value?: string | null) {
  const key = value?.trim() ?? '';
  if (!key) return [];
  return key.startsWith('human:')
    ? [key, key.slice('human:'.length)]
    : [key, `human:${key}`];
}

function memberIdentityKeys(member: ConversationParticipant, currentAccountId?: string | null) {
  return new Set([
    ...identityKeyVariants(member.id),
    ...identityKeyVariants(memberStableId(member)),
    ...identityKeyVariants(member.humanId),
    ...identityKeyVariants(member.sourceIdentityId),
    ...(isSelfMember(member) ? identityKeyVariants(currentAccountId) : []),
  ]);
}

function memberIsAdmin(member: ConversationParticipant, adminIds: Set<string>, currentAccountId?: string | null) {
  const keys = memberIdentityKeys(member, currentAccountId);
  return [...adminIds].some((adminId) => identityKeyVariants(adminId).some((key) => keys.has(key)));
}

function memberMatchesIdentity(member: ConversationParticipant, identityId?: string | null, currentAccountId?: string | null) {
  const keys = memberIdentityKeys(member, currentAccountId);
  return identityKeyVariants(identityId).some((key) => keys.has(key));
}

function contactStableId(contact: Contact) {
  return contact.sourceHumanId?.trim()
    || contact.sourceParticipantId?.trim()
    || (contact.id.startsWith('cloud:') ? contact.id.slice('cloud:'.length).trim() : '')
    || contact.id.trim();
}

function isOpaqueIdentityLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('acct_')
    || normalized.startsWith('human:acct_')
    || normalized.startsWith('cloud:acct_');
}

function visibleIdentityLabel(value: string) {
  const normalized = value.trim();
  return normalized && !isOpaqueIdentityLabel(normalized) ? normalized : '';
}

function duplicateNameCounts(names: string[]) {
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function hasDuplicateName(name: string, counts: Map<string, number>) {
  return (counts.get(name.trim().toLowerCase()) ?? 0) > 1;
}

function normalizedSearch(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function filterGroupManagementMembers(
  members: ConversationParticipant[],
  query: string,
) {
  const needle = normalizedSearch(query);
  if (!needle) return members;
  return members.filter((member) => [
    member.name,
    member.id,
    member.humanId,
    member.sourceIdentityId,
  ].some((value) => value?.toLocaleLowerCase().includes(needle)));
}

function groupActionErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'The group could not be updated. Try again.';
}

export function GroupDetailsDialog({
  isOpen,
  space,
  contacts,
  currentAccountId,
  onClose,
  onRename,
  onAddMembers,
  onRemoveMember,
  onSetAdmin,
  onAddContact,
  onCreateGroupInvitation,
  onListGroupInvitations,
  onRevokeGroupInvitation,
  onMessageContact,
  anchorRect = null,
}: GroupDetailsDialogProps) {
  const memberSearchId = useId();
  const addSearchId = useId();
  const nameInputId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const memberSearchRef = useRef<HTMLInputElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [viewport, setViewport] = useState<ViewportSize | undefined>(undefined);
  const [nameDraft, setNameDraft] = useState(space?.title ?? '');
  const [memberQuery, setMemberQuery] = useState('');
  const [addQuery, setAddQuery] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [isAddPeopleOpen, setIsAddPeopleOpen] = useState(false);
  const [addPeopleMode, setAddPeopleMode] = useState<'contacts' | 'link'>('contacts');
  const [isEditingName, setIsEditingName] = useState(false);
  const [confirmingRemovalId, setConfirmingRemovalId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [gridFocusId, setGridFocusId] = useState<string | null>(null);
  const [showAllMembers, setShowAllMembers] = useState(false);

  const session = space?.sessions[0] ?? null;
  const groupSessionIds = useMemo(
    () => (space ? participantSpaceCanonicalSessionIds(space) : []),
    [space],
  );
  const groupMembershipSessionIds = useMemo(
    () => (space ? participantSpaceCanonicalMembershipSessionIds(space) : []),
    [space],
  );
  const members = useMemo(() => {
    const participants = space?.participants ?? session?.conversation.canonicalParticipants ?? [];
    return participants.filter(isHumanMember);
  }, [session?.conversation.canonicalParticipants, space?.participants]);
  const memberIdentityIds = useMemo(() => new Set(members.flatMap((member) => [
    member.id,
    memberStableId(member),
  ])), [members]);
  const adminIds = useMemo(() => groupAdminIds(space, members), [members, space]);
  const currentMember = members.find(isSelfMember);
  const currentMemberIsAdmin = Boolean(currentMember && memberIsAdmin(currentMember, adminIds, currentAccountId));
  const currentMemberIsCreator = Boolean(currentMember && memberMatchesIdentity(currentMember, space?.groupCreatorIdentityId, currentAccountId));
  const canManageAdmins = currentMemberIsCreator;
  const canManageMembers = currentMemberIsAdmin;
  const canManageGroup = canManageMembers;
  const canInvitePeople = Boolean(currentMember);
  const canShareInvitation = currentMemberIsAdmin && Boolean(onCreateGroupInvitation);
  const adminMembers = members.filter((member) => memberIsAdmin(member, adminIds, currentAccountId));
  const adminCount = adminMembers.length;
  const invitationPermissionHint = adminMembers.length === 1
    ? `Ask ${adminMembers[0].name} to share a link or make you an admin.`
    : 'Ask a group admin to share a link or make you an admin.';
  const addOptions = useMemo(() => (
    buildChatCreateGroupPersonOptions(contacts).filter((option) => {
      const identityId = contactCanonicalIdentityRequest(option.contact).id;
      return !memberIdentityIds.has(option.contact.id)
        && !memberIdentityIds.has(option.id)
        && !memberIdentityIds.has(contactStableId(option.contact))
        && !memberIdentityIds.has(identityId ?? '');
    })
  ), [contacts, memberIdentityIds]);
  const duplicateNames = useMemo(() => duplicateNameCounts([
    ...members.map((member) => member.name),
    ...addOptions.map((option) => option.label),
  ]), [addOptions, members]);
  const filteredMembers = useMemo(
    () => filterGroupManagementMembers(members, memberQuery),
    [memberQuery, members],
  );
  // Keep Add people after the last visible member. When the gallery is
  // collapsed, reserve its final (20th) slot for that action.
  const collapsedVisibleMemberLimit = Math.max(
    1,
    COLLAPSED_MEMBER_GRID_ITEMS - (canInvitePeople ? 1 : 0),
  );
  const memberListCanCollapse = filteredMembers.length > collapsedVisibleMemberLimit;
  const visibleMembers = showAllMembers || !memberListCanCollapse
    ? filteredMembers
    : filteredMembers.slice(0, collapsedVisibleMemberLimit);
  const hiddenMemberCount = Math.max(0, filteredMembers.length - visibleMembers.length);
  const filteredAddOptions = useMemo(() => {
    const needle = normalizedSearch(addQuery);
    if (!needle) return addOptions;
    return addOptions.filter((option) => [
      option.label,
      option.detail,
      option.id,
      contactStableId(option.contact),
    ].some((value) => value?.toLocaleLowerCase().includes(needle)));
  }, [addOptions, addQuery]);
  const selectedMember = members.find((member) => member.id === selectedMemberId) ?? null;
  const selectedAddContactIds = addOptions
    .filter((option) => selectedContactIds.includes(option.id))
    .map((option) => option.id);
  const presenceByContactId = useMemo(
    () => new Map(contacts.map((contact) => [contactStableId(contact), contact.presenceStatus])),
    [contacts],
  );
  const gridItemIds = useMemo(() => [
    ...visibleMembers.map((member) => member.id),
    ...(canInvitePeople ? ['__add_people__'] : []),
  ], [canInvitePeople, visibleMembers]);

  const memberPresence = useCallback((member: ConversationParticipant) => (
    presenceByContactId.get(memberStableId(member)) ?? member.presenceStatus ?? 'offline'
  ), [presenceByContactId]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setNameDraft(space?.title ?? '');
    setMemberQuery('');
    setAddQuery('');
    setSelectedMemberId(null);
    setSelectedContactIds([]);
    setIsAddPeopleOpen(false);
    setAddPeopleMode('contacts');
    setIsEditingName(false);
    setConfirmingRemovalId(null);
    setPendingAction(null);
    setActionError(null);
    setGridFocusId(null);
    setShowAllMembers(false);
  }, [isOpen, space?.id, space?.title]);

  useEffect(() => {
    if (!isEditingName || typeof document === 'undefined') return;
    const input = document.getElementById(nameInputId);
    if (!(input instanceof HTMLInputElement)) return;
    input.focus();
    input.select();
    input.scrollIntoView({ block: 'nearest' });
  }, [isEditingName, nameInputId]);
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return undefined;
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    updateViewport();
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !space || typeof document === 'undefined' || typeof window === 'undefined') return undefined;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    memberSearchRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(GROUP_MANAGEMENT_FOCUSABLE_SELECTOR))
        .filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const previous = previouslyFocusedRef.current;
      queueMicrotask(() => previous?.focus());
    };
  }, [isOpen, space?.id]);

  if (!isOpen || !space || groupSessionIds.length === 0) return null;

  const { style, arrowStyle, placement } = groupManagementGeometry(anchorRect, viewport);
  const resolvedGridFocusId = gridFocusId && gridItemIds.includes(gridFocusId)
    ? gridFocusId
    : gridItemIds[0] ?? null;

  const runAction = async (
    actionId: string,
    action: () => Promise<void> | void,
    onSuccess?: () => void,
  ) => {
    if (pendingAction) return;
    setPendingAction(actionId);
    setActionError(null);
    try {
      await action();
      onSuccess?.();
    } catch (error) {
      setActionError(groupActionErrorMessage(error));
    } finally {
      setPendingAction(null);
    }
  };

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (!canManageGroup) return;
    const name = nameDraft.trim();
    if (!name) return;
    void runAction('rename', () => onRename(groupSessionIds, name), () => setIsEditingName(false));
  };

  const toggleAddContact = (contactId: string) => {
    setSelectedContactIds((current) => (
      current.includes(contactId)
        ? current.filter((id) => id !== contactId)
        : [...current, contactId]
    ));
  };

  const openAddPeople = () => {
    if (!canInvitePeople) return;
    setSelectedMemberId(null);
    setConfirmingRemovalId(null);
    setActionError(null);
    setIsAddPeopleOpen(true);
    setAddPeopleMode('contacts');
    setAddQuery('');
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Group management"
        aria-busy={pendingAction ? 'true' : undefined}
        tabIndex={-1}
        data-group-management-surface="popover"
        data-popover-placement={placement}
        data-member-count={members.length}
        data-filtered-member-count={filteredMembers.length}
        className="app-transient-surface app-frosted-popover app-group-management-popover app-group-management-popover-enter fixed z-[60] overflow-hidden rounded-[16px]"
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

        <div className="app-group-management-layout flex min-h-0 w-full flex-col">
          <GroupProfileHeader
            space={space}
            memberCount={members.length}
            adminCount={adminCount}
            canInvitePeople={canInvitePeople}
            canManageGroup={canManageGroup}
            onClose={onClose}
            onShowMembers={() => memberSearchRef.current?.focus()}
            onAddPeople={openAddPeople}
            onManage={() => {
              setNameDraft(space.title);
              setIsEditingName(true);
              setActionError(null);
            }}
          />

          <div
            className="app-transient-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-3"
            onClick={(event) => {
              const target = event.target;
              if (!(target instanceof Element)) return;
              if (target.closest('[data-group-member-grid-item], [data-group-member-actions]')) return;
              setSelectedMemberId(null);
              setConfirmingRemovalId(null);
            }}
          >
            {actionError ? (
              <div role="alert" className="app-group-management-error mb-3 rounded-[11px] px-2.5 py-2 text-[11px] leading-4">
                {actionError}
              </div>
            ) : null}

            <section aria-label="Group members">
              <label htmlFor={memberSearchId} className="sr-only">Search group members</label>
              <div className="app-group-management-search relative mb-3">
                <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--utility-muted-text)]" />
                <input
                  ref={memberSearchRef}
                  id={memberSearchId}
                  type="search"
                  value={memberQuery}
                  onChange={(event) => {
                    setMemberQuery(event.target.value);
                    setShowAllMembers(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowDown') return;
                    const firstItem = dialogRef.current?.querySelector<HTMLButtonElement>('[data-group-member-grid-item]');
                    if (!firstItem) return;
                    event.preventDefault();
                    firstItem.focus();
                  }}
                  placeholder="Search members"
                  className="app-input-shell h-9 w-full rounded-[11px] py-2 pl-8 pr-3 text-[12px] outline-none"
                />
              </div>
              <span className="sr-only" aria-live="polite">
                {memberQuery ? `${filteredMembers.length} of ${members.length} members` : `${members.length} members`}
              </span>

              <div
                role="group"
                aria-label="Group members"
                data-group-member-grid
                id={`${memberSearchId}-member-grid`}
                className="app-group-management-member-grid"
              >
                {visibleMembers.map((member) => {
                  const admin = memberIsAdmin(member, adminIds, currentAccountId);
                  const selected = selectedMember?.id === member.id;
                  const identityLabel = visibleIdentityLabel(memberStableId(member));
                  const showIdentityLabel = hasDuplicateName(member.name, duplicateNames)
                    && identityLabel
                    && identityLabel !== member.name;
                  return (
                    <button
                      key={member.id}
                      type="button"
                      data-group-member-grid-item
                      data-member-role={admin ? 'admin' : 'member'}
                      aria-label={`${member.name}, ${admin ? 'admin' : 'member'}${showIdentityLabel ? `, ${identityLabel}` : ''}`}
                      aria-expanded={selected}
                      aria-controls={selected ? `${memberSearchId}-member-actions` : undefined}
                      tabIndex={resolvedGridFocusId === member.id ? 0 : -1}
                      className={cn('app-group-management-member-tile min-w-0 rounded-[12px] px-1 py-2 text-center transition', selected && 'app-group-management-member-tile-selected')}
                      onFocus={() => setGridFocusId(member.id)}
                      onKeyDown={handleGridArrowNavigation}
                      onClick={() => {
                        setIsAddPeopleOpen(false);
                        setConfirmingRemovalId(null);
                        setActionError(null);
                        setSelectedMemberId((current) => (current === member.id ? null : member.id));
                      }}
                    >
                      <span className="relative mx-auto block h-9 w-9">
                        <IdentityAvatar
                          kind="human"
                          seed={member.avatarKey ?? memberStableId(member)} isSelf={isSelfMember(member)}
                          name={member.name}
                          imageUrl={member.profileImageUrl}
                          className="h-9 w-9 border border-white/10"
                          presenceStatus={memberPresence(member)}
                          presenceLabel={`${member.name} is ${memberPresence(member) === 'online' ? 'online' : 'offline'}`}
                        />
                        {admin ? (
                          <span className="app-group-management-admin-mark absolute -right-0.5 -top-0.5 grid h-4 w-4 place-items-center rounded-full" aria-hidden="true">
                            <Star className="h-3 w-3 fill-current" strokeWidth={1.75} />
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1.5 block truncate text-[10.5px] font-medium leading-4" title={member.name}>
                        {member.name}
                      </span>
                      {showIdentityLabel ? (
                        <span className="block truncate text-[9.5px] leading-3 text-[color:var(--utility-muted-text)]">
                          {identityLabel}
                        </span>
                      ) : null}
                    </button>
                  );
                })}

                {canInvitePeople ? (
                  <button
                    type="button"
                    data-group-member-grid-item
                    aria-label="Add people"
                    aria-expanded={isAddPeopleOpen}
                    tabIndex={resolvedGridFocusId === '__add_people__' ? 0 : -1}
                    className={cn('app-group-management-member-tile app-group-management-add-tile min-w-0 rounded-[12px] px-1 py-2 text-center transition', isAddPeopleOpen && 'app-group-management-member-tile-selected')}
                    onFocus={() => setGridFocusId('__add_people__')}
                    onKeyDown={handleGridArrowNavigation}
                    onClick={openAddPeople}
                  >
                    <span className="app-group-management-add-avatar mx-auto grid h-9 w-9 place-items-center rounded-[12px] border border-dashed">
                      <Plus className="h-4 w-4" />
                    </span>
                    <span className="mt-1.5 block truncate text-[10.5px] font-medium leading-4">Add</span>
                  </button>
                ) : null}
              </div>

              {memberListCanCollapse ? (
                <button
                  type="button"
                  className="app-button-quiet app-group-management-show-all mt-1 flex w-full items-center justify-center gap-1 rounded-[9px] py-1.5 text-[10px] font-medium"
                  aria-expanded={showAllMembers}
                  aria-controls={`${memberSearchId}-member-grid`}
                  onClick={() => setShowAllMembers((current) => !current)}
                >
                  {showAllMembers ? 'Show less' : 'Show all'}
                  {showAllMembers
                    ? <ChevronUp className="h-3 w-3" aria-hidden="true" />
                    : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
                  {!showAllMembers && hiddenMemberCount > 0 ? (
                    <span className="sr-only"> ({hiddenMemberCount} more people)</span>
                  ) : null}
                </button>
              ) : null}

              {filteredMembers.length === 0 ? (
                <div className="app-group-management-empty mt-2 rounded-[11px] px-2.5 py-3 text-center text-[11px]">
                  No members match “{memberQuery.trim()}”.
                </div>
              ) : null}
            </section>

            {selectedMember ? (() => {
              const admin = memberIsAdmin(selectedMember, adminIds, currentAccountId);
              const isCreator = memberMatchesIdentity(selectedMember, space.groupCreatorIdentityId, currentAccountId);
              const isSelf = isSelfMember(selectedMember);
              const canChangeAdminRole = canManageAdmins && !isCreator;
              const canRemoveMember = !isCreator && (
                isSelf || (canManageMembers && !admin)
              );
              const isPending = pendingAction === `admin:${selectedMember.id}`
                || pendingAction === `remove:${selectedMember.id}`;
              return (
                <section
                  id={`${memberSearchId}-member-actions`}
                  aria-label={`Manage ${selectedMember.name}`}
                  data-group-member-actions
                  className="app-group-management-member-actions mt-2 border-b pb-2"
                >
                  <div className="py-1">
                    <MemberContactProfileContent
                      key={selectedMember.id}
                      participant={selectedMember}
                      contacts={contacts}
                      metadataMode="kordi-handle"
                      presenceStatus={memberPresence(selectedMember)}
                      isSelf={isSelf}
                      onAddContact={onAddContact}
                      onMessageContact={onMessageContact}
                    />
                  </div>

                  {canChangeAdminRole ? (
                    <button
                      type="button"
                      className="app-transient-flat-action app-group-management-action-row mt-1 flex w-full items-center justify-between gap-3 rounded-[10px] px-2 py-2 text-left text-[11px]"
                      disabled={Boolean(pendingAction)}
                      onClick={() => {
                        void runAction(
                          `admin:${selectedMember.id}`,
                          () => onSetAdmin(groupMembershipSessionIds, selectedMember.id, !admin),
                        );
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <Star className={cn('h-3.5 w-3.5', admin && 'fill-current')} />
                        {admin ? 'Remove admin role' : 'Make group admin'}
                      </span>
                      {pendingAction === `admin:${selectedMember.id}` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </button>
                  ) : null}

                  {canRemoveMember ? (
                    confirmingRemovalId === selectedMember.id ? (
                      <div className="app-group-management-confirm mt-1 rounded-[10px] px-2 py-2">
                        <p className="text-[10.5px] leading-4">
                          {isSelf ? 'Leave this group?' : `Remove ${selectedMember.name} from this group?`}
                        </p>
                        <div className="mt-2 flex justify-end gap-1.5">
                          <button
                            type="button"
                            className="app-transient-flat-action rounded-[9px] px-2.5 py-1.5 text-[10px]"
                            disabled={isPending}
                            onClick={() => setConfirmingRemovalId(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="app-transient-flat-action app-transient-flat-action-danger rounded-[9px] px-2.5 py-1.5 text-[10px]"
                            disabled={isPending}
                            onClick={() => {
                              void runAction(
                                `remove:${selectedMember.id}`,
                                () => onRemoveMember(groupMembershipSessionIds, selectedMember.id),
                                () => {
                                  setSelectedMemberId(null);
                                  setConfirmingRemovalId(null);
                                },
                              );
                            }}
                          >
                            {pendingAction === `remove:${selectedMember.id}` ? 'Removing…' : isSelf ? 'Leave group' : 'Remove'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="app-transient-flat-action app-transient-flat-action-danger app-group-management-action-row mt-1 flex w-full items-center justify-between gap-3 rounded-[10px] px-2 py-2 text-left text-[11px]"
                        disabled={Boolean(pendingAction)}
                        onClick={() => setConfirmingRemovalId(selectedMember.id)}
                      >
                        <span className="flex items-center gap-2">
                          <UserMinus className="h-3.5 w-3.5" />
                          {isSelf ? 'Leave group' : 'Remove from group'}
                        </span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    )
                  ) : null}
                </section>
              );
            })() : null}

            {isAddPeopleOpen ? (
              <section aria-labelledby={`${addSearchId}-heading`} className="app-group-management-add-panel mt-3 border-t pt-2">
                <div className="flex items-center gap-2 px-1 py-1">
                  <button
                    type="button"
                    className="app-button-quiet app-group-management-close grid h-7 w-7 place-items-center rounded-[9px] p-0"
                    aria-label="Back to group members"
                    onClick={() => {
                      setIsAddPeopleOpen(false);
                      setSelectedContactIds([]);
                    }}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <h3 id={`${addSearchId}-heading`} className="text-[12px] font-semibold">Add people</h3>
                  </div>
                  {addPeopleMode === 'contacts' && selectedAddContactIds.length > 0 ? (
                    <span className="text-[10px] tabular-nums text-[color:var(--utility-muted-text)]">
                      {selectedAddContactIds.length} selected
                    </span>
                  ) : null}
                </div>

                <div className="app-filter-tabs app-group-management-add-tabs my-2 w-full" role="tablist" aria-label="Ways to add people">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={addPeopleMode === 'contacts'}
                    className={addPeopleMode === 'contacts' ? 'app-filter-tab app-filter-tab-active' : 'app-filter-tab'}
                    onClick={() => {
                      setAddPeopleMode('contacts');
                      setActionError(null);
                    }}
                  >
                    Existing contacts
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={addPeopleMode === 'link'}
                    className={addPeopleMode === 'link' ? 'app-filter-tab app-filter-tab-active' : 'app-filter-tab'}
                    onClick={() => {
                      setAddPeopleMode('link');
                      setActionError(null);
                    }}
                  >
                    Share link
                  </button>
                </div>

                {addPeopleMode === 'contacts' ? (
                  <>
                    <label htmlFor={addSearchId} className="sr-only">Search contacts to add</label>
                    <div className="app-group-management-search relative my-2">
                      <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--utility-muted-text)]" />
                      <input
                        id={addSearchId}
                        type="search"
                        value={addQuery}
                        onChange={(event) => setAddQuery(event.target.value)}
                        placeholder="Search contacts"
                        className="app-input-shell h-9 w-full rounded-[11px] py-2 pl-8 pr-3 text-[12px] outline-none"
                      />
                    </div>

                    <div className="space-y-0.5" aria-label="Contacts available to add">
                      {filteredAddOptions.length > 0 ? filteredAddOptions.map((option) => {
                        const selected = selectedContactIds.includes(option.id);
                        const rawIdentityLabel = contactStableId(option.contact);
                        const identityLabel = visibleIdentityLabel(rawIdentityLabel);
                        const detail = visibleIdentityLabel(option.detail ?? '');
                        const showIdentityLabel = hasDuplicateName(option.label, duplicateNames)
                          && identityLabel
                          && identityLabel !== option.label;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            disabled={!canInvitePeople || Boolean(pendingAction)}
                            aria-pressed={selected}
                            onClick={() => toggleAddContact(option.id)}
                            className={cn('app-group-management-contact-row flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-[11px] transition', selected && 'app-group-management-contact-row-selected')}
                          >
                            <IdentityAvatar
                              kind="human"
                              seed={option.avatarSeed ?? rawIdentityLabel}
                              name={option.label}
                              imageUrl={option.profileImageUrl}
                              className="h-7 w-7 border border-white/10"
                              presenceStatus={option.contact.presenceStatus}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{option.label}</span>
                              {showIdentityLabel || detail ? (
                                <span className="block truncate text-[9.5px] text-[color:var(--utility-muted-text)]">
                                  {showIdentityLabel ? identityLabel : detail}
                                </span>
                              ) : null}
                            </span>
                            <span className={cn('app-group-management-contact-check grid h-5 w-5 place-items-center rounded-full border', selected && 'app-group-management-contact-check-selected')}>
                              {selected ? <Check className="h-3 w-3" /> : null}
                            </span>
                          </button>
                        );
                      }) : addOptions.length > 0 ? (
                        <div className="app-group-management-empty rounded-[11px] px-2.5 py-3 text-center text-[11px]">
                          No contacts match “{addQuery.trim()}”.
                        </div>
                      ) : (
                        <div className="app-group-management-empty rounded-[11px] px-2.5 py-3 text-center text-[11px]">
                          No existing contacts are available to add.
                        </div>
                      )}
                    </div>

                    <Button
                      type="button"
                      className="mt-2 h-9 w-full rounded-[11px] text-[11px]"
                      disabled={!canInvitePeople || selectedAddContactIds.length === 0 || Boolean(pendingAction)}
                      onClick={() => {
                        void runAction(
                          'add-members',
                          () => onAddMembers(groupSessionIds, selectedAddContactIds),
                          () => {
                            setSelectedContactIds([]);
                            setIsAddPeopleOpen(false);
                          },
                        );
                      }}
                    >
                      {pendingAction === 'add-members' ? (
                        <><LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Adding…</>
                      ) : selectedAddContactIds.length > 0 ? `Add ${selectedAddContactIds.length} ${selectedAddContactIds.length === 1 ? 'person' : 'people'}` : 'Select people to add'}
                    </Button>
                  </>
                ) : (
                  <GroupInvitationSharePanel
                    hidden={false}
                    space={space}
                    canShareInvitation={canShareInvitation}
                    permissionHint={invitationPermissionHint}
                    pendingAction={pendingAction}
                    onCreateGroupInvitation={onCreateGroupInvitation}
                    onListGroupInvitations={onListGroupInvitations}
                    onRevokeGroupInvitation={onRevokeGroupInvitation}
                    runAction={runAction}
                    onError={setActionError}
                  />
                )}
              </section>
            ) : null}

            <section aria-label="Group settings" className="app-group-management-settings mt-3 border-t pt-1">
              <button
                type="button"
                className="app-transient-flat-action app-group-management-setting-row flex w-full items-center gap-3 rounded-[10px] px-1.5 py-2.5 text-left"
                disabled={!canManageGroup || Boolean(pendingAction)}
                aria-expanded={isEditingName}
                onClick={() => {
                  setNameDraft(space.title);
                  setIsEditingName((current) => !current);
                  setActionError(null);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-medium">Group name</span>
                  <span className="mt-0.5 block truncate text-[10px] text-[color:var(--utility-muted-text)]">{space.title}</span>
                </span>
                {canManageGroup ? <Pencil className="h-3.5 w-3.5 text-[color:var(--utility-muted-text)]" /> : null}
              </button>

              {isEditingName ? (
                <form className="app-group-management-name-form px-1.5 pb-2" onSubmit={submitRename}>
                  <label htmlFor={nameInputId} className="sr-only">Group name</label>
                  <input
                    id={nameInputId}
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    className="app-input-shell h-9 w-full rounded-[11px] px-3 text-[12px] outline-none"
                  />
                  <div className="mt-2 flex justify-end gap-1.5">
                    <button
                      type="button"
                      className="app-transient-flat-action rounded-[9px] px-2.5 py-1.5 text-[10px]"
                      disabled={pendingAction === 'rename'}
                      onClick={() => {
                        setNameDraft(space.title);
                        setIsEditingName(false);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="app-button-primary rounded-[9px] px-2.5 py-1.5 text-[10px]"
                      disabled={!nameDraft.trim() || nameDraft.trim() === space.title.trim() || Boolean(pendingAction)}
                    >
                      {pendingAction === 'rename' ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </form>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
