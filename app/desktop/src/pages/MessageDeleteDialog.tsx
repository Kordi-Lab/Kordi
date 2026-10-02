import { useId, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import type { Message } from '@/kordi-app/types';
import { transcriptMessageIsOwnHuman } from '@/kordi-app/components/transcriptMessageHumanRole';
import { cn } from '@/lib/utils';
import { MESSAGE_DELETE_ERROR } from '@/pages/messageDeleteCopy';

type DeleteChoice = 'me' | 'everyone';

const REMOVE_FROM_VIEW_HELPER = 'Hides it on your devices. Others in the chat still see it.';
const DELETE_FOOTNOTE = 'People who already saw it may have saved a copy or taken a screenshot. '
  + "If an agent already read it, the agent's reply and what it received stay.";

// Mention storage only when the server reports that it removes stored copies.
function deleteForEveryoneHelper(group: boolean, peerName: string, serverDeletesStoredCopies: boolean) {
  if (!serverDeletesStoredCopies) {
    return 'Removes it for everyone in this chat. Copies may remain on the server.';
  }
  const name = peerName.trim();
  return group || !name
    ? 'Removes it for everyone in this chat, and Kordi deletes its text and files from chat storage.'
    : `Removes it for you and ${name}, and Kordi deletes its text and files from chat storage.`;
}

function DeleteChoiceButton({
  choice,
  label,
  busyLabel,
  helper,
  pending,
  danger = false,
  onChoose,
}: {
  choice: DeleteChoice;
  label: string;
  busyLabel: string;
  helper: string;
  pending: DeleteChoice | null;
  danger?: boolean;
  onChoose: (choice: DeleteChoice) => void;
}) {
  const helperId = useId();
  const pressed = pending === choice;
  return (
    <div className="min-w-0">
      <button
        type="button"
        data-message-delete-choice={choice}
        disabled={pending !== null}
        aria-busy={pressed || undefined}
        aria-describedby={helperId}
        onClick={() => onChoose(choice)}
        className={cn(
          'app-button-quiet inline-flex min-h-8 w-full items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-left text-[12px] font-semibold leading-4 disabled:opacity-50',
          danger ? 'app-transient-flat-action-danger' : 'text-[color:var(--utility-foreground)]',
        )}
      >
        {pressed ? <LoaderCircle className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
        <span className="min-w-0 break-words">{pressed ? busyLabel : label}</span>
      </button>
      <p id={helperId} className="app-transient-muted mt-0.5 mb-0 px-2.5 text-[11px] leading-4">
        {helper}
      </p>
    </div>
  );
}

export function MessageDeleteDialog({
  message,
  peerName,
  group,
  serverDeletesStoredCopies = false,
  onCancel,
  onDelete,
}: {
  message: Message;
  peerName: string;
  group: boolean;
  /** True only when the server reports content removal version 1 or higher. */
  serverDeletesStoredCopies?: boolean;
  onCancel: () => void;
  onDelete: (forEveryone: boolean) => Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const isOwnMessage = transcriptMessageIsOwnHuman(message);
  const [pending, setPending] = useState<DeleteChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== null;

  const choose = async (choice: DeleteChoice) => {
    if (busy) return;
    setPending(choice);
    setError(null);
    try {
      await onDelete(isOwnMessage && choice === 'everyone');
      onCancel();
    } catch {
      setError(MESSAGE_DELETE_ERROR);
      setPending(null);
    }
  };

  const errorText = error ? (
    <p className="app-error-text mt-2 mb-0 text-[11px] leading-4 text-rose-500" role="alert">
      {error}
    </p>
  ) : null;
  const cancelButton = (
    <button
      type="button"
      autoFocus
      disabled={busy}
      onClick={onCancel}
      className="app-button-quiet h-[26px] rounded-[7px] px-2 text-[11px] font-medium text-[color:var(--utility-foreground)] disabled:opacity-50"
    >
      Cancel
    </button>
  );

  if (!isOwnMessage) {
    return (
      <AppDialog
        titleId={titleId}
        descriptionId={descriptionId}
        onDismiss={onCancel}
        dismissDisabled={busy}
        className="max-w-[22rem] rounded-[18px] p-4"
      >
        <AppDialogTitle id={titleId} className="text-[14px] leading-5">
          Remove this message from your view?
        </AppDialogTitle>
        <AppDialogDescription id={descriptionId} className="mt-1 text-[11px] leading-4">
          Others in the chat still see it.
        </AppDialogDescription>
        {errorText}
        <AppDialogActions className="mt-2.5 flex-wrap gap-1">
          {cancelButton}
          <button
            type="button"
            data-message-delete-choice="me"
            className="app-button-quiet app-transient-flat-action-danger inline-flex min-h-[26px] items-center gap-1 rounded-[7px] px-2 text-[11px] font-semibold disabled:opacity-50"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => { void choose('me'); }}
          >
            {busy ? <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
            {busy ? 'Removing…' : 'Remove from my view'}
          </button>
        </AppDialogActions>
      </AppDialog>
    );
  }

  // Cancel is last in document order and keeps autofocus, so Tab moves from
  // Cancel to "Remove from my view" and then to "Delete for everyone".
  return (
    <AppDialog
      titleId={titleId}
      descriptionId={descriptionId}
      onDismiss={onCancel}
      dismissDisabled={busy}
      className="max-w-[22rem] rounded-[18px] p-4"
    >
      <AppDialogTitle id={titleId} className="text-[14px] leading-5">Delete this message?</AppDialogTitle>
      <div className="mt-2.5 flex flex-col gap-2">
        <DeleteChoiceButton
          choice="me"
          label="Remove from my view"
          busyLabel="Removing…"
          helper={REMOVE_FROM_VIEW_HELPER}
          pending={pending}
          onChoose={(choice) => { void choose(choice); }}
        />
        <DeleteChoiceButton
          choice="everyone"
          label="Delete for everyone"
          busyLabel="Deleting…"
          helper={deleteForEveryoneHelper(group, peerName, serverDeletesStoredCopies)}
          pending={pending}
          danger
          onChoose={(choice) => { void choose(choice); }}
        />
      </div>
      <AppDialogDescription id={descriptionId} className="mt-2.5 px-2.5 text-[11px] leading-4">
        {DELETE_FOOTNOTE}
      </AppDialogDescription>
      {errorText}
      <AppDialogActions className="mt-2.5 gap-1">
        {cancelButton}
      </AppDialogActions>
    </AppDialog>
  );
}
