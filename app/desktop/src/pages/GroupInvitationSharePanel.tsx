import { useEffect, useState } from 'react';
import { Check, Copy, LoaderCircle, LockKeyhole, Share } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CopyToast } from '@/components/ui/copyFeedback';
import { ErrorLine, withoutTryAgain } from '@/components/ui/errors';
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
  runAction: RunGroupAction;
  onError: (message: string | null) => void;
};

function groupSpaceIdFromViewModel(space: ParticipantSpaceViewModel) {
  const id = space.id.trim();
  return id.startsWith('group:') ? id.slice('group:'.length) : id;
}

/** A group has one link that every admin sees and shares. */
export function GroupInvitationSharePanel({
  hidden,
  space,
  canShareInvitation,
  permissionHint,
  pendingAction,
  onCreateGroupInvitation,
  onListGroupInvitations,
  runAction,
  onError,
}: GroupInvitationSharePanelProps) {
  const [invitation, setInvitation] = useState<CloudGroupInvitation | null>(null);
  // A failed link shows under the link button, not at the top of the dialog.
  // `reset` remembers which request failed, so Try again repeats it.
  const [linkError, setLinkError] = useState<{ message: string; reset: boolean } | null>(null);
  const [isLoading, setIsLoading] = useState(
    canShareInvitation && Boolean(onListGroupInvitations),
  );
  const [confirmingReset, setConfirmingReset] = useState(false);
  const { copied, copy, reset: resetCopied } = useCopyFeedback();

  const groupSpaceId = groupSpaceIdFromViewModel(space);
  useEffect(() => {
    if (hidden || !canShareInvitation || !groupSpaceId || !onListGroupInvitations) return undefined;
    let active = true;
    void onListGroupInvitations(groupSpaceId)
      .then((invitations) => {
        const current = invitations.find((item) => item.inviteUrl);
        if (active && current?.inviteUrl) {
          setInvitation({ invitationId: current.invitationId, inviteUrl: current.inviteUrl, expiresAt: current.expiresAt });
        }
      })
      .catch((error: unknown) => {
        if (active) onError(groupInvitationLinkErrorMessage(error));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => { active = false; };
  }, [canShareInvitation, groupSpaceId, hidden, onError, onListGroupInvitations]);

  const requestLink = (reset: boolean) => {
    if (!onCreateGroupInvitation || !canShareInvitation) return;
    if (!groupSpaceId) {
      setLinkError({ message: 'This group is not ready to share yet.', reset });
      return;
    }
    setLinkError(null);
    const actionId = reset ? 'reset-group-invitation' : 'create-group-invitation';
    void runAction(actionId, async () => {
      let nextInvitation: CloudGroupInvitation;
      try {
        nextInvitation = await onCreateGroupInvitation({
          groupId: groupSpaceId,
          groupSpaceId,
          groupTitle: space.title,
          ...(reset ? { reset: true } : {}),
        });
      } catch (error) {
        setLinkError({ message: groupInvitationLinkErrorMessage(error), reset });
        return;
      }
      setInvitation(nextInvitation);
      setConfirmingReset(false);
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

  if (hidden) return null;
  const busy = Boolean(pendingAction);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  // Offer "Try again" only for a plain retry message, not "Try again later" or a fix-it hint.
  const linkMessage = linkError?.message ?? null;
  const linkRetryable = linkMessage !== null && withoutTryAgain(linkMessage) !== linkMessage;
  const linkErrorLine = linkError && linkMessage ? (
    <ErrorLine
      className="mt-2"
      action={linkRetryable ? { label: 'Try again', onClick: () => requestLink(linkError.reset), disabled: busy } : null}
    >
      {linkRetryable ? withoutTryAgain(linkMessage) : linkMessage}
    </ErrorLine>
  ) : null;
  const spinner = <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  const quietButton = 'h-7 rounded-[8px] px-2.5 text-[10.5px] font-medium';
  const iconButton = 'grid h-9 w-9 shrink-0 place-items-center rounded-[10px] p-0';
  const footer = 'mt-2 flex items-center gap-1 text-[9.5px] text-[color:var(--utility-muted-text)]';
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
              className={`app-button-primary ${iconButton}`}
              aria-label={copied ? 'Link copied' : 'Copy link'}
              title={copied ? 'Copied' : 'Copy link'}
              onClick={() => { void copyInvitation(); }}
            >
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
            {canShare ? (
              <button
                type="button"
                className={`app-input-shell ${iconButton}`}
                aria-label="Share invitation link"
                title="Share"
                onClick={() => { void navigator.share({ url: invitation.inviteUrl }).catch(() => {}); }}
              >
                <Share className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {confirmingReset ? (
            <div className={footer}>
              <span className="mr-auto">The current link will stop working.</span>
              <Button type="button" variant="quiet" size="sm" className={quietButton} disabled={busy} onClick={() => setConfirmingReset(false)}>
                Cancel
              </Button>
              <Button type="button" variant="quiet" size="sm" className={quietButton} disabled={busy} onClick={() => requestLink(true)}>
                {pendingAction === 'reset-group-invitation' ? 'Resetting…' : 'Reset'}
              </Button>
            </div>
          ) : (
            <div className={footer}>
              <span className="mr-auto">{expiryLabel(invitation.expiresAt)}</span>
              <Button type="button" variant="quiet" size="sm" className={quietButton} disabled={busy} onClick={() => setConfirmingReset(true)}>
                Reset link
              </Button>
            </div>
          )}
          {linkErrorLine}
          <CopyToast visible={copied} />
        </>
      ) : (
        <>
          <Button
            type="button"
            className="mt-3 h-9 w-full rounded-[11px] text-[11px]"
            disabled={isLoading || busy}
            onClick={() => requestLink(false)}
          >
            {isLoading ? <>{spinner} Checking…</>
              : pendingAction === 'create-group-invitation' ? <>{spinner} Creating…</>
                : 'Create link'}
          </Button>
          {linkErrorLine}
        </>
      )}
    </div>
  );
}
