import { useEffect, useState } from 'react';
import { Check, Copy, LoaderCircle, LockKeyhole } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CopyToast } from '@/components/ui/copyFeedback';
import { ErrorLine, withoutTryAgain } from '@/components/ui/ErrorLine';
import { useCopyFeedback } from '@/components/ui/useCopyFeedback';
import { groupInvitationLinkErrorMessage, invitationExpiryLabel as expiryLabel } from '@/features/chat/groupCreateCopy';
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
  // A failed link shows under the link button, not at the top of the dialog.
  const [linkError, setLinkError] = useState<string | null>(null);
  const [activeInvitations, setActiveInvitations] = useState<CloudGroupInvitationSummary[]>([]);
  const [isLoadingActive, setIsLoadingActive] = useState(
    canShareInvitation && Boolean(onListGroupInvitations),
  );
  const { copied, copy, reset: resetCopied } = useCopyFeedback();

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
      setLinkError('This group is not ready to share yet.');
      return;
    }
    setLinkError(null);
    void runAction('create-group-invitation', async () => {
      let nextInvitation: CloudGroupInvitation;
      try {
        nextInvitation = await onCreateGroupInvitation({
          groupId: groupSpaceId,
          groupSpaceId,
          groupTitle: space.title,
        });
      } catch (error) {
        setLinkError(groupInvitationLinkErrorMessage(error));
        return;
      }
      // A new link replaces the earlier ones.
      setInvitation(nextInvitation);
      setActiveInvitations([]);
      resetCopied();
    });
  };

  const copyInvitation = async () => {
    if (!invitation?.inviteUrl) return;
    onError(null);
    try {
      await copy(invitation.inviteUrl);
    } catch {
      onError("Couldn't copy the link. Select it and copy it.");
    }
  };

  const revokeInvitation = (invitationId: string) => {
    if (!onRevokeGroupInvitation) return;
    void runAction(
      'revoke-group-invitation',
      () => onRevokeGroupInvitation(invitationId),
      () => {
        setInvitation((current) => (current?.invitationId === invitationId ? null : current));
        setActiveInvitations((current) => current.filter((item) => item.invitationId !== invitationId));
        resetCopied();
      },
    );
  };

  if (hidden) return null;
  const busy = Boolean(pendingAction);
  const activeInvitation = activeInvitations[0] ?? null;
  // Offer "Try again" only for a plain retry message, not "Try again later" or a fix-it hint.
  const linkRetryable = linkError !== null && withoutTryAgain(linkError) !== linkError;
  const linkErrorLine = linkError ? (
    <ErrorLine
      className="mt-2"
      action={linkRetryable ? { label: 'Try again', onClick: createInvitation, disabled: busy } : null}
    >
      {linkRetryable ? withoutTryAgain(linkError) : linkError}
    </ErrorLine>
  ) : null;
  const spinner = <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  return (
    <div role="tabpanel" aria-label="Invite with a link" className="px-1 pb-2">
      {!canShareInvitation ? (
        <div className="mt-3 flex items-start gap-2.5 py-1">
          <LockKeyhole
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--utility-muted-text)]"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-[10.5px] font-medium">Only group admins can share a link</p>
            {permissionHint ? (
              <p className="mt-1 text-[9.5px] leading-4 text-[color:var(--utility-muted-text)]">
                {permissionHint}
              </p>
            ) : null}
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
              aria-label={copied ? 'Link copied' : 'Copy link'}
              title={copied ? 'Copied' : 'Copy link'}
              onClick={() => { void copyInvitation(); }}
            >
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1 text-[9.5px] text-[color:var(--utility-muted-text)]">
            <span className="mr-auto">{expiryLabel(invitation.expiresAt)}</span>
            <Button
              type="button"
              variant="quiet"
              size="sm"
              className="h-7 rounded-[8px] px-2.5 text-[10.5px] font-medium"
              disabled={busy}
              onClick={createInvitation}
            >
              {pendingAction === 'create-group-invitation' ? 'Creating…' : 'New link'}
            </Button>
            {onRevokeGroupInvitation ? (
              <Button
                type="button"
                variant="quiet"
                size="sm"
                className="h-7 rounded-[8px] px-2.5 text-[10.5px] font-medium"
                disabled={busy}
                onClick={() => revokeInvitation(invitation.invitationId)}
              >
                {pendingAction === 'revoke-group-invitation' ? 'Revoking…' : 'Revoke'}
              </Button>
            ) : null}
          </div>
          {linkErrorLine}
          <CopyToast visible={copied} />
        </>
      ) : (
        <>
          <Button
            type="button"
            className="mt-3 h-9 w-full rounded-[11px] text-[11px]"
            disabled={isLoadingActive || busy}
            onClick={createInvitation}
          >
            {isLoadingActive ? <>{spinner} Checking…</>
              : pendingAction === 'create-group-invitation' ? <>{spinner} Creating…</>
                : activeInvitation ? 'New link' : 'Create link'}
          </Button>
          {linkErrorLine}
          {activeInvitation ? (
            <div className="mt-2 flex items-center gap-1 text-[9.5px] text-[color:var(--utility-muted-text)]">
              <span className="mr-auto">A link is active · {expiryLabel(activeInvitation.expiresAt).toLowerCase()}</span>
              {onRevokeGroupInvitation ? (
                <Button
                  type="button"
                  variant="quiet"
                  size="sm"
                  className="h-7 rounded-[8px] px-2.5 text-[10.5px] font-medium"
                  disabled={busy}
                  onClick={() => revokeInvitation(activeInvitation.invitationId)}
                >
                  {pendingAction === 'revoke-group-invitation' ? 'Revoking…' : 'Revoke'}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
