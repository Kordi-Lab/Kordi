import { useState } from 'react';
import { Ban, Flag, LoaderCircle, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSafetyActions } from '@/features/safety/safetyActions';
import { REMOVE_CONTACT_HELPER, safetyErrorMessage } from '@/features/safety/safetyCopy';
import { isServiceAccountId } from '@/features/safety/serviceAccounts';

type ContactSafetyButtonsProps = {
  accountId: string | null | undefined;
  name: string;
  /** Sent with a report made while reviewing that request. */
  contactRequestId?: string | null;
  /** Runs before a dialog opens, for example to close the overlay. */
  onBeforeOpen?: () => void;
};

/** "Block…" and "Report…" for another person, when the server supports them. */
export function ContactSafetyButtons({ accountId, name, contactRequestId, onBeforeOpen }: ContactSafetyButtonsProps) {
  const safety = useSafetyActions();
  const id = accountId?.trim() ?? '';
  if (
    !safety.safetyFeaturesAvailable
    || !id.startsWith('acct_')
    || id === safety.account?.accountId
    || isServiceAccountId(id)
  ) return null;
  const blocked = safety.blockedAccountIds.has(id);
  return (
    <>
      <Button
        variant="secondary"
        className="app-transient-flat-action rounded-[10px]"
        onClick={() => {
          onBeforeOpen?.();
          if (blocked) safety.openUnblock({ accountId: id, name });
          else safety.openBlock({ accountId: id, name });
        }}
      >
        <Ban className="mr-2 h-4 w-4" aria-hidden="true" />
        {blocked ? 'Unblock…' : 'Block…'}
      </Button>
      <Button
        variant="secondary"
        className="app-transient-flat-action rounded-[10px]"
        onClick={() => {
          onBeforeOpen?.();
          safety.openReport({ accountId: id, name, contactRequestId: contactRequestId ?? null });
        }}
      >
        <Flag className="mr-2 h-4 w-4" aria-hidden="true" />
        Report…
      </Button>
    </>
  );
}

type RemoveContactControlProps = {
  name: string;
  onRemove: () => Promise<void> | void;
  onDone: () => void;
};

/** "Remove contact" with an inline confirmation and the outcome in place. */
export function RemoveContactControl({ name, onRemove, onDone }: RemoveContactControlProps) {
  const [stage, setStage] = useState<'idle' | 'confirming' | 'saving' | 'removed'>('idle');
  const [error, setError] = useState('');

  const remove = async () => {
    if (stage === 'saving') return;
    setStage('saving');
    setError('');
    try {
      await onRemove();
      setStage('removed');
    } catch (caught) {
      setStage('confirming');
      setError(safetyErrorMessage(caught, `Couldn't remove ${name}. Check your connection and try again.`));
    }
  };

  if (stage === 'removed') {
    return (
      <div className="grid gap-2">
        <p role="status" aria-live="polite" className="m-0 text-[12px] leading-5">{`${name} was removed from your contacts.`}</p>
        <Button variant="secondary" className="app-transient-flat-action rounded-[10px]" onClick={onDone} autoFocus>
          Done
        </Button>
      </div>
    );
  }

  if (stage === 'idle') {
    return (
      <Button
        variant="secondary"
        className="app-transient-flat-action app-transient-flat-action-danger rounded-[10px] shadow-none"
        onClick={() => setStage('confirming')}
      >
        <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
        Remove contact
      </Button>
    );
  }

  return (
    <div className="app-group-management-confirm grid gap-2 rounded-[10px] px-2 py-2" role="group" aria-label={`Remove ${name}`}>
      <p className="m-0 text-[12px] font-semibold leading-5">{`Remove ${name} from your contacts?`}</p>
      <p className="app-transient-muted m-0 text-[11px] leading-4">{REMOVE_CONTACT_HELPER}</p>
      <p aria-live="polite" className="app-error-text m-0 text-[11px] leading-4 text-rose-200">{error}</p>
      <div className="flex justify-end gap-1.5">
        <Button
          variant="secondary"
          className="app-transient-flat-action rounded-[9px]"
          disabled={stage === 'saving'}
          onClick={() => { setStage('idle'); setError(''); }}
        >
          Cancel
        </Button>
        <Button
          variant="secondary"
          className="app-transient-flat-action app-transient-flat-action-danger rounded-[9px]"
          disabled={stage === 'saving'}
          onClick={() => { void remove(); }}
        >
          {stage === 'saving' ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          Remove contact
        </Button>
      </div>
    </div>
  );
}
