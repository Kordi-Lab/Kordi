import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, LoaderCircle, Users, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  CloudAuthError,
  defaultCloudAuthClient,
  type CloudGroupInvitationAcceptance,
  type CloudGroupInvitationPreview,
} from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';

type GroupInvitationDialogProps = {
  invitationToken: string;
  onDismiss: () => void;
  onJoined: (result: CloudGroupInvitationAcceptance) => void;
};

type InvitationState =
  | { status: 'loading'; preview: null; message: '' }
  | { status: 'ready'; preview: CloudGroupInvitationPreview; message: '' }
  | { status: 'joining'; preview: CloudGroupInvitationPreview; message: '' }
  | { status: 'joined'; preview: CloudGroupInvitationPreview; message: string }
  | { status: 'error'; preview: CloudGroupInvitationPreview | null; message: string };

function invitationErrorMessage(error: unknown) {
  if (error instanceof CloudAuthError) {
    if (error.code === 'group_invitation_expired') {
      return 'This invitation expired. Ask a group admin for a new link.';
    }
    if (error.code === 'group_invitation_full') {
      return 'This group is full. Ask a group admin to remove someone before trying again.';
    }
    if (error.code === 'invalid_group_invitation') {
      return 'This invitation is invalid or was revoked. Ask a group admin for a new link.';
    }
    if (error.code === 'self_group_invitation') {
      return 'You created this invitation. Open the group from your sidebar instead.';
    }
    if (error.code === 'wrong_group_invitation_account') {
      return 'This account cannot join with this invitation. Sign in with the account you want to add.';
    }
    if (error.code === 'network_error') {
      return 'You appear to be offline. Reconnect and try again.';
    }
  }
  return error instanceof Error ? error.message : 'Kordi could not load this invitation.';
}

function invitationExpiryLabel(value: string) {
  const expiresAt = new Date(value);
  if (!Number.isFinite(expiresAt.getTime())) return 'Invitation expires soon';
  return `Invitation expires ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(expiresAt)}`;
}

export function GroupInvitationDialog({
  invitationToken,
  onDismiss,
  onJoined,
}: GroupInvitationDialogProps) {
  const client = useMemo(() => defaultCloudAuthClient(), []);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<InvitationState>({
    status: 'loading',
    preview: null,
    message: '',
  });

  const retryPreview = async () => {
    setState({ status: 'loading', preview: null, message: '' });
    try {
      const preview = await client.resolveGroupInvitation(invitationToken);
      setState({ status: 'ready', preview, message: '' });
    } catch (error) {
      setState({ status: 'error', preview: null, message: invitationErrorMessage(error) });
    }
  };

  useEffect(() => {
    let active = true;
    void client.resolveGroupInvitation(invitationToken)
      .then((preview) => {
        if (active) setState({ status: 'ready', preview, message: '' });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ status: 'error', preview: null, message: invitationErrorMessage(error) });
        }
      });
    return () => { active = false; };
  }, [client, invitationToken]);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    queueMicrotask(() => closeButtonRef.current?.focus());
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const previous = previouslyFocusedRef.current;
      queueMicrotask(() => previous?.focus());
    };
  }, [onDismiss]);

  useEffect(() => {
    if (state.status === 'ready' || state.status === 'error' || state.status === 'joined') {
      primaryActionRef.current?.focus();
    }
  }, [state.status]);

  const joinGroup = async () => {
    if (!state.preview || state.status === 'joining') return;
    const preview = state.preview;
    setState({ status: 'joining', preview, message: '' });
    try {
      const session = await loadSession();
      if (!session?.token) throw new Error('Sign in to preview and join this group.');
      const result = await client.acceptGroupInvitation(session.token, invitationToken);
      setState({
        status: 'joined',
        preview,
        message: result.status === 'already_joined'
          ? `You are already in ${result.groupTitle}.`
          : `You joined ${result.groupTitle}.`,
      });
      onJoined(result);
    } catch (error) {
      setState({ status: 'error', preview, message: invitationErrorMessage(error) });
    }
  };

  const preview = state.preview;
  const inviterName = preview?.inviter.displayName?.trim() || 'A Kordi user';
  const memberCount = preview?.group.memberCount ?? 0;

  return (
    <div
      className="app-group-invitation-overlay fixed inset-0 z-[100] grid place-items-center bg-black/35 px-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="group-invitation-title"
        aria-describedby="group-invitation-description"
        aria-busy={state.status === 'loading' || state.status === 'joining'}
        className="app-transient-surface app-frosted-popover w-full max-w-[390px] rounded-[20px] p-4 shadow-[var(--app-shadow-float)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="app-group-invitation-group-avatar grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-[var(--app-control-bg)] text-[color:var(--utility-foreground)]">
              <Users className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="group-invitation-title" className="truncate text-[15px] font-semibold leading-5">
                {preview?.group.name || 'Group invitation'}
              </h2>
              <p className="mt-0.5 text-[10.5px] text-[color:var(--utility-muted-text)]">
                {preview ? `${memberCount} ${memberCount === 1 ? 'member' : 'members'}` : 'Loading invitation…'}
              </p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="app-button-quiet grid h-8 w-8 shrink-0 place-items-center rounded-[10px] p-0"
            aria-label="Dismiss group invitation"
            onClick={onDismiss}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {state.status === 'loading' ? (
          <div className="flex min-h-36 items-center justify-center" aria-live="polite">
            <LoaderCircle className="h-5 w-5 animate-spin text-[color:var(--utility-muted-text)] motion-reduce:animate-none" />
            <span className="sr-only">Loading group invitation</span>
          </div>
        ) : preview ? (
          <>
            <div className="mt-4 flex items-center gap-2.5 border-y border-[color:var(--app-divider)] py-3">
              <IdentityAvatar
                kind="human"
                seed={`group-inviter:${preview.inviter.kordiId}`}
                name={inviterName}
                imageUrl={preview.inviter.avatarUrl}
                className="h-8 w-8 border border-white/10"
              />
              <p id="group-invitation-description" className="min-w-0 text-[11px] leading-[1.5]">
                <span className="font-semibold">{inviterName}</span>{' '}
                invited you to join. You will not add this person or any group member as a contact.
              </p>
            </div>

            <p className="mt-3 text-[10px] leading-4 text-[color:var(--utility-muted-text)]">
              {invitationExpiryLabel(preview.expiresAt)}
            </p>

            {state.message ? (
              <div
                role={state.status === 'error' ? 'alert' : 'status'}
                className={`mt-3 rounded-[11px] px-3 py-2 text-[10.5px] leading-4 ${
                  state.status === 'error'
                    ? 'bg-rose-500/10 text-[color:var(--app-transient-danger-text)]'
                    : 'bg-emerald-500/10 text-emerald-600'
                }`}
              >
                {state.message}
              </div>
            ) : null}

            <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
              {state.status === 'joined' ? (
                <Button
                  ref={primaryActionRef}
                  type="button"
                  className="h-10 rounded-[11px] text-[11px]"
                  onClick={onDismiss}
                >
                  <Check className="mr-1.5 h-3.5 w-3.5" /> Open group
                </Button>
              ) : (
                <Button
                  ref={primaryActionRef}
                  type="button"
                  className="h-10 rounded-[11px] text-[11px]"
                  disabled={state.status === 'joining'}
                  onClick={() => { void joinGroup(); }}
                >
                  {state.status === 'joining' ? (
                    <><LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Joining…</>
                  ) : 'Join group'}
                </Button>
              )}
              <button
                type="button"
                className="app-button-quiet min-h-10 rounded-[11px] px-3 text-[11px]"
                onClick={onDismiss}
              >
                Not now
              </button>
            </div>
          </>
        ) : (
          <div className="mt-4">
            <p id="group-invitation-description" role="alert" className="rounded-[11px] bg-rose-500/10 px-3 py-2.5 text-[11px] leading-4 text-[color:var(--app-transient-danger-text)]">
              {state.message}
            </p>
            <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
              <Button
                ref={primaryActionRef}
                type="button"
                className="h-10 rounded-[11px] text-[11px]"
                onClick={() => { void retryPreview(); }}
              >
                Try again
              </Button>
              <button
                type="button"
                className="app-button-quiet min-h-10 rounded-[11px] px-3 text-[11px]"
                onClick={onDismiss}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
