import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const DIALOG_CLASS = 'max-w-sm rounded-[20px]';
// Account settings is itself a high overlay, so these sit above it.
const BACKDROP_CLASS = '!z-[100000]';

/** Asks before saving a new Kordi ID, since it can change only once a year. */
export function KordiIdChangeConfirmDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <AppDialog
      titleId="kordi-id-change-title"
      descriptionId="kordi-id-change-description"
      onDismiss={onCancel}
      className={DIALOG_CLASS}
      backdropClassName={BACKDROP_CLASS}
    >
      <AppDialogTitle id="kordi-id-change-title">Change your Kordi ID?</AppDialogTitle>
      <AppDialogDescription id="kordi-id-change-description">You can change it once a year.</AppDialogDescription>
      <AppDialogActions>
        <Button variant="quiet" className="rounded-full px-4" autoFocus onClick={onCancel}>Cancel</Button>
        <Button className="rounded-full px-4" onClick={onConfirm}>Change</Button>
      </AppDialogActions>
    </AppDialog>
  );
}

/** Explains why a recently changed Kordi ID is read-only. */
export function KordiIdLockedDialog({ availableOn, onClose }: { availableOn: string; onClose: () => void }) {
  return (
    <AppDialog
      titleId="kordi-id-locked-title"
      descriptionId="kordi-id-locked-description"
      onDismiss={onClose}
      className={DIALOG_CLASS}
      backdropClassName={BACKDROP_CLASS}
    >
      <AppDialogTitle id="kordi-id-locked-title">Kordi ID</AppDialogTitle>
      <AppDialogDescription id="kordi-id-locked-description">You can change it again on {availableOn}.</AppDialogDescription>
      <AppDialogActions>
        <Button className="rounded-full px-4" autoFocus onClick={onClose}>OK</Button>
      </AppDialogActions>
    </AppDialog>
  );
}
