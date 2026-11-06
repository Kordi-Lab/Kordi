import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Users, X } from 'lucide-react';

import {
  CloudAuthError,
  defaultCloudAuthClient,
  type CloudAuthClient,
  type CloudGroupInvitationAcceptance,
  type CloudGroupInvitationPreview,
  type CloudPendingGroupInvitation,
} from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';

type InvitationSource =
  | { invitationToken: string; pendingInvitation?: undefined; onAcceptPending?: undefined }
  | {
    invitationToken?: undefined;
    /** Already claimed on the server, so the dialog needs no resolve call. */
    pendingInvitation: CloudPendingGroupInvitation;
    onAcceptPending: (invitation: CloudPendingGroupInvitation) => Promise<CloudGroupInvitationAcceptance>;
  };

export type GroupInvitationDialogProps = InvitationSource & {
  onDismiss: () => void;
  onJoined: (result: CloudGroupInvitationAcceptance) => void;
  client?: Pick<CloudAuthClient, 'resolveGroupInvitation' | 'acceptGroupInvitation'>;
  loadToken?: () => Promise<string | null>;
};

type InvitationSummary = { groupName: string; inviterName: string; memberCount: number };

type InvitationState =
  | { status: 'loading'; summary: null; message: '' }
  | { status: 'ready' | 'joining'; summary: InvitationSummary; message: '' }
  | { status: 'joined'; summary: InvitationSummary; message: string }
  | { status: 'error'; summary: InvitationSummary | null; message: string; retryable: boolean };

/** Only a failure to reach Kordi can be fixed by trying again. */
function isRetryableInvitationError(error: unknown) {
  if (!(error instanceof CloudAuthError)) return false;
  return error.code === 'network_error' || error.code === 'rate_limited' || error.status === 0 || error.status >= 500;
}

function errorState(summary: InvitationSummary | null, error: unknown): InvitationState {
  return {
    status: 'error',
    summary,
    message: groupInvitationErrorMessage(error),
    retryable: isRetryableInvitationError(error),
  };
}

function groupInvitationErrorMessage(error: unknown) {
  if (error instanceof CloudAuthError) {
    switch (error.code) {
      case 'invitation_unavailable':
      case 'group_invitation_expired':
        return 'This link expired. Ask the sender for a new one.';
      case 'group_full':
      case 'group_invitation_full':
        return 'This group is full.';
      case 'invalid_group_invitation':
        return 'This invitation is invalid or was revoked. Ask the sender for a new link.';
      case 'self_group_invitation':
        return 'You created this invitation. Open the group from your sidebar instead.';
      case 'wrong_group_invitation_account':
        return 'This account cannot join with this invitation. Sign in with the account you want to add.';
      case 'network_error':
        return 'You appear to be offline. Reconnect and try again.';
      default:
        break;
    }
  }
  return error instanceof Error ? error.message : 'Kordi could not load this invitation.';
}

function summaryFromPreview(preview: CloudGroupInvitationPreview): InvitationSummary {
  return {
    groupName: preview.group.name,
    inviterName: preview.inviter.displayName?.trim() || 'A Kordi user',
    memberCount: preview.group.memberCount,
  };
}

function summaryFromPending(pending: CloudPendingGroupInvitation): InvitationSummary {
  return {
    groupName: pending.groupName,
    inviterName: pending.inviterName?.trim() || 'A Kordi user',
    memberCount: pending.memberCount,
  };
}

async function loadSessionToken() {
  return (await loadSession())?.token ?? null;
}

export function GroupInvitationDialog({
  invitationToken,
  pendingInvitation,
  onAcceptPending,
  onDismiss,
  onJoined,
  client: injectedClient,
  loadToken = loadSessionToken,
}: GroupInvitationDialogProps) {
  const client = useMemo(() => injectedClient ?? defaultCloudAuthClient(), [injectedClient]);
  const dialogRef = useRef<HTMLElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<InvitationState>(() => (pendingInvitation
    ? { status: 'ready', summary: summaryFromPending(pendingInvitation), message: '' }
    : { status: 'loading', summary: null, message: '' }));

  const loadPreview = useCallback((isActive: () => boolean) => {
    if (!invitationToken) return;
    void client.resolveGroupInvitation(invitationToken)
      .then((preview) => {
        if (isActive()) setState({ status: 'ready', summary: summaryFromPreview(preview), message: '' });
      })
      .catch((error: unknown) => {
        if (isActive()) setState(errorState(null, error));
      });
  }, [client, invitationToken]);

  useEffect(() => {
    let active = true;
    loadPreview(() => active);
    return () => { active = false; };
  }, [loadPreview]);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      // Focus rings show only once the user moves focus with the keyboard.
      if (event.key === 'Tab') dialogRef.current?.setAttribute('data-keyboard-nav', 'true');
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
    // Both modes open with focus on the primary action (the dialog itself
    // while the deep-link preview loads), without a visible ring.
    queueMicrotask(() => (primaryActionRef.current ?? dialogRef.current)?.focus());
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

  const retryPreview = () => {
    setState({ status: 'loading', summary: null, message: '' });
    loadPreview(() => true);
  };

  const joinGroup = async () => {
    if (!state.summary || state.status === 'joining') return;
    const summary = state.summary;
    setState({ status: 'joining', summary, message: '' });
    try {
      let result: CloudGroupInvitationAcceptance;
      if (pendingInvitation) {
        result = await onAcceptPending(pendingInvitation);
      } else {
        const token = await loadToken();
        if (!token) throw new Error('Sign in to join this group.');
        result = await client.acceptGroupInvitation(token, invitationToken);
      }
      setState({
        status: 'joined',
        summary,
        message: result.status === 'already_joined'
          ? `You are already in ${result.groupTitle}.`
          : `You joined ${result.groupTitle}.`,
      });
      onJoined(result);
    } catch (error) {
      setState(errorState(summary, error));
    }
  };

  const summary = state.summary;
  const memberLabel = summary
    ? `${summary.memberCount} ${summary.memberCount === 1 ? 'member' : 'members'}`
    : '';
  const failed = state.status === 'error';
  const finalError = failed && !state.retryable;
  const canRetryPreview = failed && state.retryable && !summary;
  const primaryLabel = state.status === 'joined'
    ? 'Open group'
    : finalError ? 'Close' : failed ? 'Try again' : 'Join';

  return (
    <div
      className="app-group-invitation-overlay app-transient-overlay fixed inset-0 z-[100] grid place-items-center px-4"
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
        onPointerDown={() => dialogRef.current?.removeAttribute('data-keyboard-nav')}
        className="app-group-invitation-dialog app-transient-surface app-frosted-popover w-full max-w-[340px] rounded-[18px] border p-4 shadow-[var(--app-shadow-float)]"
      >
        <div className="flex items-start justify-between gap-3">
          <span
            className="app-group-invitation-group-avatar grid h-11 w-11 place-items-center rounded-[14px]"
            style={{ background: 'var(--app-transient-raised-bg)' }}
          >
            <Users className="h-5 w-5" aria-hidden="true" />
          </span>
          <button
            type="button"
            className="app-button-quiet app-transient-muted grid h-7 w-7 place-items-center rounded-[9px] p-0"
            aria-label="Dismiss group invitation"
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <h2 id="group-invitation-title" className="mt-3 truncate text-[15px] font-semibold leading-5">
          {summary ? `Join ${summary.groupName}?` : 'Group invitation'}
        </h2>
        {state.status === 'loading' ? (
          <div className="flex min-h-16 items-center justify-center" aria-live="polite">
            <LoaderCircle className="h-5 w-5 animate-spin text-[color:var(--utility-muted-text)] motion-reduce:animate-none" />
            <span id="group-invitation-description" className="sr-only">Loading group invitation</span>
          </div>
        ) : summary ? (
          <p id="group-invitation-description" className="app-transient-metadata mt-1 text-[11.5px]">
            {summary.inviterName} invited you · {memberLabel}
          </p>
        ) : null}

        {state.message ? (
          <p
            id={summary ? undefined : 'group-invitation-description'}
            role={failed && !finalError ? 'alert' : 'status'}
            className={finalError
              ? 'mt-2 text-[11.5px] leading-4 text-[color:var(--app-transient-text)]'
              : `mt-3 rounded-[10px] px-3 py-2 text-[11px] leading-4 ${
                failed
                  ? 'bg-rose-500/10 text-[color:var(--app-transient-danger-text)]'
                  : 'bg-emerald-500/10 text-emerald-600'
              }`}
          >
            {state.message}
          </p>
        ) : null}

        {state.status === 'loading' ? null : (
          <div className={`mt-4 grid gap-2 ${finalError ? 'grid-cols-1' : 'grid-cols-[1fr_auto]'}`}>
            <button
              ref={primaryActionRef}
              type="button"
              className="app-button-primary inline-flex h-9 items-center justify-center rounded-[10px] text-[12px] font-medium disabled:opacity-70"
              disabled={state.status === 'joining'}
              onClick={() => {
                if (state.status === 'joined' || finalError) onDismiss();
                else if (canRetryPreview) retryPreview();
                else void joinGroup();
              }}
            >
              {state.status === 'joining' ? (
                <><LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Joining…</>
              ) : primaryLabel}
            </button>
            {finalError ? null : (
              <button
                type="button"
                className="app-button-quiet h-9 rounded-[10px] px-3 text-[12px]"
                onClick={onDismiss}
              >
                Not now
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
