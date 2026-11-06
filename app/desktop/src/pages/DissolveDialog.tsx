import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { AppDialog, AppDialogActions, AppDialogTitle, type AppDialogAnchor } from '@/components/ui/dialog';
import { groupDissolveErrorMessage } from '@/features/chat/groupCreateCopy';

type DissolveDialogProps = {
  scope: 'group' | 'channel';
  name: string;
  anchorRect?: AppDialogAnchor | null;
  /** Lifts the dialog above a surface it opens from, such as group Info. */
  backdropClassName?: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
};

/** Confirms dissolving a group or one of its channels: everyone loses access. */
export function DissolveDialog({ scope, name, anchorRect = null, backdropClassName, onCancel, onConfirm }: DissolveDialogProps) {
  const [isDissolving, setIsDissolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = `dissolve-${scope}-dialog-title`;
  const lineId = `dissolve-${scope}-dialog-line`;
  const cancel = () => {
    if (!isDissolving) onCancel();
  };
  const confirm = async () => {
    if (isDissolving) return;
    setIsDissolving(true);
    setError(null);
    try {
      await onConfirm();
      onCancel();
    } catch (caught) {
      setError(groupDissolveErrorMessage(caught, scope));
      setIsDissolving(false);
    }
  };
  return (
    <AppDialog
      titleId={titleId}
      descriptionId={lineId}
      onDismiss={cancel}
      dismissDisabled={isDissolving}
      busy={isDissolving}
      presentation={anchorRect ? 'popover' : 'modal'}
      anchorRect={anchorRect}
      backdropClassName={backdropClassName}
    >
      <AppDialogTitle id={titleId} className="text-[13px] leading-5">Dissolve {name}?</AppDialogTitle>
      <p id={lineId} className="app-transient-muted mt-2 text-[11px] leading-4">
        Everyone loses access to this {scope}.
      </p>
      {error ? (
        <div className="app-error-text mt-2 text-[11px] leading-4 text-rose-500" role="alert">
          {error}
        </div>
      ) : null}
      <AppDialogActions className="mt-3 gap-2">
        <Button variant="quiet" size="sm" className="rounded-[12px] px-3" autoFocus disabled={isDissolving} onClick={cancel}>Cancel</Button>
        <Button
          size="sm"
          className="app-transient-danger-button rounded-[12px] px-3"
          disabled={isDissolving}
          aria-busy={isDissolving}
          onClick={() => { void confirm(); }}
        >
          {isDissolving ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          <span>{isDissolving ? 'Dissolving…' : 'Dissolve'}</span>
        </Button>
      </AppDialogActions>
    </AppDialog>
  );
}
