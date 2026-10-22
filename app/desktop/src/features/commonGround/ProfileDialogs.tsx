import { useId } from 'react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { CgButton } from './parts';
import type { CgProfile } from './types';

export function DeleteProfileDialog({ profile, busy, onCancel, onDelete }: { profile: CgProfile; busy: boolean; onCancel: () => void; onDelete: () => void }) {
  const titleId = useId();
  const lineId = useId();
  return (
    <AppDialog titleId={titleId} descriptionId={lineId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog">
      <AppDialogTitle id={titleId}>Delete {profile.name}?</AppDialogTitle>
      <AppDialogDescription id={lineId}>Its card goes, and you leave rooms it was shared in.</AppDialogDescription>
      <AppDialogActions>
        <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
        <button type="button" className="cg-button is-danger" onClick={onDelete} disabled={busy}>Delete</button>
      </AppDialogActions>
    </AppDialog>
  );
}
