import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

import type { CloudDeviceAuthorization } from './cloudDeviceClient';
import { deviceTitle, sessionCountLabel, type CloudDeviceGroup } from './cloudDeviceGroups';

export type Confirmation =
  | { kind: 'one'; device: CloudDeviceAuthorization; operationId: string }
  | { kind: 'group'; group: CloudDeviceGroup; operationIds: Map<string, string> }
  | { kind: 'legacy'; devices: CloudDeviceAuthorization[]; operationIds: Map<string, string> }
  | { kind: 'others'; operationId: string };

export type RenameRequest = {
  device: CloudDeviceAuthorization;
  displayName: string;
  operationId: string;
};

function confirmationCopy(confirmation: Confirmation): { title: string; description: string | null } {
  switch (confirmation.kind) {
    case 'one':
      return { title: `Log out of ${deviceTitle(confirmation.device)}?`, description: null };
    case 'group':
      return {
        title: `Log out of ${confirmation.group.title}?`,
        description: `${sessionCountLabel(confirmation.group.sessionCount)} will be signed out.`,
      };
    case 'legacy': {
      const count = confirmation.devices.length;
      return {
        title: 'Log out of all older sign-ins?',
        description: `${count === 1 ? '1 older sign-in' : `${count} older sign-ins`} will be signed out.`,
      };
    }
    case 'others':
      return {
        title: 'Log out of all other devices?',
        description: 'Every device except this one will be signed out.',
      };
  }
}

export function DeviceRenameDialog({
  request,
  busy,
  onChange,
  onDismiss,
  onSave,
}: {
  request: RenameRequest;
  busy: boolean;
  onChange: (displayName: string) => void;
  onDismiss: () => void;
  onSave: () => void;
}) {
  return (
    <AppDialog
      titleId="device-rename-title"
      onDismiss={onDismiss}
      dismissDisabled={busy}
      busy={busy}
      className="max-w-md rounded-[20px]"
      backdropClassName="!z-[100000]"
    >
      <AppDialogTitle id="device-rename-title">Rename this device</AppDialogTitle>
      <label className="mt-4 block text-[11px] font-medium text-slate-300" htmlFor="device-display-name">
        Device name
      </label>
      <input
        id="device-display-name"
        className="app-input-shell mt-2 h-10 w-full rounded-[12px] px-3 text-[13px] text-white outline-none"
        value={request.displayName}
        maxLength={80}
        autoFocus
        disabled={busy}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onSave();
          }
        }}
      />
      <AppDialogActions>
        <Button variant="quiet" className="rounded-full px-4" disabled={busy} onClick={onDismiss}>Cancel</Button>
        <Button className="rounded-full px-4" disabled={busy || !request.displayName.trim()} onClick={onSave}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </AppDialogActions>
    </AppDialog>
  );
}

export function DeviceLogoutDialog({
  confirmation,
  busy,
  onDismiss,
  onConfirm,
}: {
  confirmation: Confirmation;
  busy: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  const copy = confirmationCopy(confirmation);
  return (
    <AppDialog
      titleId="device-revocation-title"
      descriptionId={copy.description ? 'device-revocation-description' : undefined}
      onDismiss={onDismiss}
      dismissDisabled={busy}
      busy={busy}
      className="max-w-md rounded-[20px]"
      backdropClassName="!z-[100000]"
    >
      <AppDialogTitle id="device-revocation-title">{copy.title}</AppDialogTitle>
      {copy.description ? (
        <AppDialogDescription id="device-revocation-description">{copy.description}</AppDialogDescription>
      ) : null}
      <AppDialogActions>
        <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={busy} onClick={onDismiss}>Cancel</Button>
        <Button className="rounded-full bg-rose-500 px-4 text-white hover:bg-rose-400" disabled={busy} onClick={onConfirm}>
          {busy ? 'Logging out…' : 'Log out'}
        </Button>
      </AppDialogActions>
    </AppDialog>
  );
}
