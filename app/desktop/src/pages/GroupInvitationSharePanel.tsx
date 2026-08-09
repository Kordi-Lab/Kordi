import { useEffect, useState } from 'react';
import { Check, Copy, Link2, LoaderCircle, LockKeyhole } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type {
  CloudGroupInvitation,
  CloudGroupInvitationCreateInput,
  CloudGroupInvitationSummary,
} from '@/features/cloud/authClient';
import type { ParticipantSpaceViewModel } from '@/kordi-app/types';

type RunGroupAction = (
  actionId: string,
  action: () => Promise<void> | void,
  onSuccess?: () => void,
) => Promise<void>;

type GroupInvitationSharePanelProps = {
  hidden: boolean;
  space: ParticipantSpaceViewModel;
  canShareInvitation: boolean;
  permissionHint: string;
  pendingAction: string | null;
  onCreateGroupInvitation?: (
    input: CloudGroupInvitationCreateInput,
  ) => Promise<CloudGroupInvitation>;
  onListGroupInvitations?: (groupSpaceId: string) => Promise<CloudGroupInvitationSummary[]>;
  onRevokeGroupInvitation?: (invitationId: string) => Promise<void>;
  runAction: RunGroupAction;
  onError: (message: string | null) => void;
};

function groupSpaceIdFromViewModel(space: ParticipantSpaceViewModel) {
  const id = space.id.trim();
  return id.startsWith('group:') ? id.slice('group:'.length) : id;
}

function invitationExpiryLabel(value: string) {
  const expiresAt = new Date(value);
  if (!Number.isFinite(expiresAt.getTime())) return 'Invitation expires soon';
  return `Expires ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(expiresAt)}`;
}

export function GroupInvitationSharePanel({
  hidden,
  space,
  canShareInvitation,
  permissionHint,
  pendingAction,
  onCreateGroupInvitation,
  onListGroupInvitations,
  onRevokeGroupInvitation,
  runAction,
  onError,
}: GroupInvitationSharePanelProps) {
  const [invitation, setInvitation] = useState<CloudGroupInvitation | null>(null);
  const [activeInvitations, setActiveInvitations] = useState<CloudGroupInvitationSummary[]>([]);
  const [isLoadingActive, setIsLoadingActive] = useState(
    canShareInvitation && Boolean(onListGroupInvitations),
  );
  const [copied, setCopied] = useState(false);

  const groupSpaceId = groupSpaceIdFromViewModel(space);
  useEffect(() => {
    if (hidden || !canShareInvitation || !groupSpaceId || !onListGroupInvitations) return undefined;
    let active = true;
    void onListGroupInvitations(groupSpaceId)
      .then((invitations) => {
        if (active) setActiveInvitations(invitations);
      })
      .catch((error: unknown) => {
        if (active) onError(error instanceof Error ? error.message : 'Could not load active invitations.');
      })
      .finally(() => {
        if (active) setIsLoadingActive(false);
      });
    return () => { active = false; };
  }, [canShareInvitation, groupSpaceId, hidden, onError, onListGroupInvitations]);

  const createInvitation = () => {
    if (!onCreateGroupInvitation || !canShareInvitation) return;
    if (!groupSpaceId) {
      onError('This group is not ready to share yet.');
      return;
    }
    void runAction('create-group-invitation', async () => {
      const nextInvitation = await onCreateGroupInvitation({
        groupId: groupSpaceId,
        groupSpaceId,
        groupTitle: space.title,
      });
      setInvitation(nextInvitation);
      setActiveInvitations([]);
      setCopied(false);
    });
  };

  const copyInvitation = async () => {
    if (!invitation?.inviteUrl) return;
    onError(null);
    try {
      await navigator.clipboard.writeText(invitation.inviteUrl);
      setCopied(true);
    } catch {
      onError('Kordi could not copy the link. Select it and copy it manually.');
    }
  };

  const revokeInvitation = (invitationId: string) => {
    if (!onRevokeGroupInvitation) return;
    void runAction(
      'revoke-group-invitation',
      () => onRevokeGroupInvitation(invitationId),
      () => {
        setInvitation(null);
        setActiveInvitations((current) => current.filter((item) => item.invitationId !== invitationId));
        setCopied(false);
      },
    );
  };

  if (hidden) return null;
  return (
    <div role="tabpanel" className="px-1 py-2">
      <div className="flex items-center gap-2.5">
        <Link2
          className="h-4 w-4 shrink-0 text-[color:var(--utility-muted-text)]"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold">Invite people to “{space.title}”</p>
        </div>
      </div>

      {!canShareInvitation ? (
        <div className="mt-3 flex items-start gap-2.5 py-1">
          <LockKeyhole
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--utility-muted-text)]"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-[10.5px] font-medium">Only group admins can create invitation links</p>
            <p className="mt-1 text-[9.5px] leading-4 text-[color:var(--utility-muted-text)]">
              {permissionHint}
            </p>
          </div>
        </div>
      ) : invitation ? (
        <>
          <div className="mt-3 flex gap-1.5">
            <input
              aria-label="Group invitation link"
              readOnly
              value={invitation.inviteUrl}
              onFocus={(event) => event.currentTarget.select()}
              className="app-input-shell h-9 min-w-0 flex-1 rounded-[10px] px-2.5 text-[10px] outline-none"
            />
            <button
              type="button"
              className="app-button-primary grid h-9 w-9 shrink-0 place-items-center rounded-[10px] p-0"
              aria-label={copied ? 'Invitation link copied' : 'Copy invitation link'}
              title={copied ? 'Copied' : 'Copy link'}
              onClick={() => { void copyInvitation(); }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-[9.5px] text-[color:var(--utility-muted-text)]">
            <span>{invitationExpiryLabel(invitation.expiresAt)}</span>
            {onRevokeGroupInvitation ? (
              <Button
                type="button"
                variant="quiet"
                size="sm"
                className="h-7 rounded-[8px] px-2.5 text-[10.5px] font-medium"
                disabled={Boolean(pendingAction)}
                onClick={() => revokeInvitation(invitation.invitationId)}
              >
                {pendingAction === 'revoke-group-invitation' ? 'Revoking…' : 'Revoke link'}
              </Button>
            ) : null}
          </div>
        </>
      ) : activeInvitations[0] ? (
        <div className="mt-3">
          <Button
            type="button"
            className="h-9 w-full rounded-[11px] text-[11px]"
            disabled={Boolean(pendingAction)}
            onClick={createInvitation}
          >
            {pendingAction === 'create-group-invitation' ? (
              <><LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Creating…</>
            ) : 'Create new share link'}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          className="mt-3 h-9 w-full rounded-[11px] text-[11px]"
          disabled={!canShareInvitation || isLoadingActive || Boolean(pendingAction)}
          onClick={createInvitation}
        >
          {isLoadingActive ? (
            <><LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Checking…</>
          ) : pendingAction === 'create-group-invitation' ? (
            <><LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Creating…</>
          ) : 'Create invitation link'}
        </Button>
      )}
    </div>
  );
}
