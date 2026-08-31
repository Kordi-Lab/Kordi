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

export function MessageDeleteDialog({
  message,
  peerName,
  group,
  onCancel,
  onDelete,
}: {
  message: Message;
  peerName: string;
  group: boolean;
  onCancel: () => void;
  onDelete: (forEveryone: boolean) => Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const isOwnMessage = transcriptMessageIsOwnHuman(message);
  const [forEveryone, setForEveryone] = useState(isOwnMessage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(Boolean(isOwnMessage && forEveryone));
      onCancel();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete message.');
      setBusy(false);
    }
  };

  return (
    <AppDialog
      titleId={titleId}
      descriptionId={descriptionId}
      onDismiss={onCancel}
      dismissDisabled={busy}
      busy={busy}
      className="max-w-[18rem] rounded-[18px] p-4"
    >
      <AppDialogTitle id={titleId} className="text-[14px] leading-5">Delete this message?</AppDialogTitle>
      <AppDialogDescription id={descriptionId} className="mt-1 text-[11px] leading-4">
        This cannot be undone.
      </AppDialogDescription>
      {isOwnMessage ? (
        <label className="mt-3 flex min-h-9 cursor-pointer items-center gap-2 rounded-[10px] px-1 text-[12px] text-[color:var(--utility-foreground)]">
          <input
            type="checkbox"
            checked={forEveryone}
            onChange={(event) => setForEveryone(event.target.checked)}
            disabled={busy}
            className="h-3.5 w-3.5 accent-rose-500"
          />
          <span className="min-w-0 break-words">
            {group ? 'Also delete for everyone' : `Also delete for ${peerName}`}
          </span>
        </label>
      ) : null}
      {error ? (
        <p className="app-error-text mt-2 text-[11px] leading-4 text-rose-500" role="alert">
          {error}
        </p>
      ) : null}
      <AppDialogActions className="mt-2.5 gap-1">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={onCancel}
          className="app-button-quiet h-[26px] rounded-[7px] px-2 text-[11px] font-medium text-[color:var(--utility-foreground)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          className="app-button-quiet app-transient-flat-action-danger inline-flex h-[26px] items-center gap-1 rounded-[7px] px-2 text-[11px] font-semibold disabled:opacity-50"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => { void confirm(); }}
        >
          {busy ? <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </AppDialogActions>
    </AppDialog>
  );
}
