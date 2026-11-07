import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorLine } from '@/components/ui/ErrorLine';
import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';

import { safetyErrorMessage } from './safetyCopy';
import type { SafetyAccountTarget } from './safetyTypes';

/** Above the account settings overlay, which hosts the Blocked page. */
export const SAFETY_DIALOG_BACKDROP_CLASS = '!z-[100000]';

type BlockAccountDialogProps = {
  mode: 'block' | 'unblock';
  target: SafetyAccountTarget;
  onConfirm: () => Promise<void>;
  onDismiss: () => void;
};

export function BlockAccountDialog({ mode, target, onConfirm, onDismiss }: BlockAccountDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const blocking = mode === 'block';
  const name = target.name;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onDismiss();
    } catch (caught) {
      setBusy(false);
      setError(safetyErrorMessage(caught, blocking ? `Couldn't block ${name}. Try again.` : `Couldn't unblock ${name}. Try again.`));
    }
  };

  return (
    <AppDialog
      titleId={titleId}
      descriptionId={blocking ? descriptionId : undefined}
      onDismiss={onDismiss}
      dismissDisabled={busy}
      busy={busy}
      className="max-w-md rounded-[20px]"
      backdropClassName={SAFETY_DIALOG_BACKDROP_CLASS}
    >
      <AppDialogTitle id={titleId}>{blocking ? `Block ${name}?` : `Unblock ${name}?`}</AppDialogTitle>
      {blocking ? (
        <AppDialogDescription id={descriptionId}>They can&apos;t message, call or invite you.</AppDialogDescription>
      ) : null}
      {error ? (
        <ErrorLine className="mt-2">{error}</ErrorLine>
      ) : null}
      <AppDialogActions>
        <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={busy} onClick={onDismiss}>Cancel</Button>
        <Button
          className={blocking ? 'rounded-full bg-rose-500 px-4 text-white hover:bg-rose-400' : 'rounded-full px-4'}
          disabled={busy}
          onClick={() => { void confirm(); }}
        >
          {blocking ? 'Block' : 'Unblock'}
        </Button>
      </AppDialogActions>
    </AppDialog>
  );
}
