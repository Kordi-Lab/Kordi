import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';

import type { CallPermissionIssue } from './callMediaPermission';

/**
 * The standard dialog for microphone or camera access that is turned off.
 * The Mac app offers System Settings; browsers explain their site settings.
 */
export function MediaPermissionDialog({
  issue,
  copy,
  onCancel,
  onOpenSettings,
}: {
  issue: CallPermissionIssue;
  copy: { title: string; description: string };
  onCancel: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <AppDialog
      titleId="media-permission-title"
      descriptionId="media-permission-description"
      onDismiss={onCancel}
      className="max-w-sm rounded-[20px]"
    >
      <AppDialogTitle id="media-permission-title">{copy.title}</AppDialogTitle>
      <AppDialogDescription id="media-permission-description">{copy.description}</AppDialogDescription>
      <AppDialogActions>
        {issue.canOpenSettings ? (
          <>
            <Button variant="quiet" className="rounded-full px-4" onClick={onCancel}>Cancel</Button>
            <Button className="rounded-full px-4" autoFocus onClick={onOpenSettings}>Open System Settings</Button>
          </>
        ) : (
          <Button className="rounded-full px-4" autoFocus onClick={onCancel}>OK</Button>
        )}
      </AppDialogActions>
    </AppDialog>
  );
}
