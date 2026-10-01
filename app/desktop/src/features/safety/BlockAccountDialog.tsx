import { useId, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

import { BLOCK_EXPLANATION, safetyErrorMessage } from './safetyCopy';
import type { SafetyAccountTarget } from './safetyTypes';

type BlockAccountDialogProps = {
  mode: 'block' | 'unblock';
  target: SafetyAccountTarget;
  onConfirm: () => Promise<void>;
  onDismiss: () => void;
  /** Opens a report about the same person instead of blocking. */
  onReport?: () => void;
};

type Stage = 'confirm' | 'working' | 'done';

export function BlockAccountDialog({ mode, target, onConfirm, onDismiss, onReport }: BlockAccountDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [stage, setStage] = useState<Stage>('confirm');
  const [error, setError] = useState('');
  const blocking = mode === 'block';
  const name = target.name;

  const confirm = async () => {
    if (stage !== 'confirm') return;
    setStage('working');
    setError('');
    try {
      await onConfirm();
      setStage('done');
    } catch (caught) {
      setStage('confirm');
      setError(safetyErrorMessage(
        caught,
        blocking
          ? `Couldn't block ${name}. Check your connection and try again.`
          : `Couldn't unblock ${name}. Check your connection and try again.`,
      ));
    }
  };

  const title = blocking ? `Block ${name}?` : `Unblock ${name}?`;
  const doneMessage = blocking ? `${name} is blocked.` : `${name} is unblocked.`;

  return (
    <AppDialog
      titleId={titleId}
      descriptionId={descriptionId}
      onDismiss={onDismiss}
      dismissDisabled={stage === 'working'}
      busy={stage === 'working'}
      className="max-w-[440px]"
    >
      <AppDialogTitle id={titleId}>{stage === 'done' ? doneMessage : title}</AppDialogTitle>
      {stage === 'done' ? (
        <>
          <p id={descriptionId} role="status" aria-live="polite" className="sr-only">{doneMessage}</p>
          <AppDialogActions>
            <Button type="button" onClick={onDismiss} autoFocus>Done</Button>
          </AppDialogActions>
        </>
      ) : (
        <>
          {blocking ? (
            <ul id={descriptionId} className="mt-3 mb-0 grid list-disc gap-1.5 pl-5 text-[13px] leading-5 text-[color:var(--utility-muted-text)]">
              {BLOCK_EXPLANATION.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : (
            <AppDialogDescription id={descriptionId}>
              They&apos;ll be able to send you a contact request again. They won&apos;t be added back to your contacts.
            </AppDialogDescription>
          )}
          <p aria-live="polite" className="app-error-text mt-3 mb-0 min-h-4 text-[12px] leading-5 text-[color:var(--app-transient-danger-text)]">
            {error}
          </p>
          <AppDialogActions className="items-center">
            {blocking && onReport ? (
              <button
                type="button"
                className="app-button-quiet mr-auto rounded-[8px] px-1 text-[12px] underline underline-offset-2"
                disabled={stage === 'working'}
                onClick={onReport}
              >
                {`Report ${name}…`}
              </button>
            ) : null}
            <Button type="button" variant="secondary" onClick={onDismiss} disabled={stage === 'working'}>
              Cancel
            </Button>
            <Button
              type="button"
              className={blocking ? 'app-transient-flat-action-danger' : undefined}
              onClick={() => { void confirm(); }}
              disabled={stage === 'working'}
            >
              {stage === 'working' ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              {blocking ? 'Block' : 'Unblock'}
            </Button>
          </AppDialogActions>
        </>
      )}
    </AppDialog>
  );
}
