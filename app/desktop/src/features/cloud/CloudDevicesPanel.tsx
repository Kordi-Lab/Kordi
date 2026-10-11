import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogOut, Pencil, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import {
  defaultCloudAuthClient,
  type CloudAuthClient,
  type CloudDeviceAuthorization,
} from './authClient';
import {
  appVersionLabel,
  deviceTitle,
  groupCloudDevices,
  platformVersionLabel,
  signInMethodLabel,
} from './cloudDeviceGroups';
import {
  DeviceLogoutDialog,
  DeviceRenameDialog,
  type Confirmation,
  type RenameRequest,
} from './CloudDevicesPanelDialogs';
import {
  DeviceCard,
  DeviceGroupCard,
  DeviceIcon,
  SessionRow,
  StatusLine,
} from './CloudDevicesPanelParts';
import { loadSession } from './session';

const cachedDevicesByAccount = new Map<string, CloudDeviceAuthorization[]>();
export const CLOUD_DEVICES_CHANGED_EVENT = 'kordi-cloud-devices-changed';

export type CloudDevicesClient = Pick<
  CloudAuthClient,
  'listDevices' | 'renameDevice' | 'confirmDevice' | 'revokeDevice' | 'revokeOtherDevices'
>;

function operationIdsFor(devices: CloudDeviceAuthorization[]): Map<string, string> {
  return new Map(devices.map((device) => [device.deviceId, crypto.randomUUID()]));
}

export type CloudDevicesSessionLoader = () => Promise<{ token: string; accountId: string } | null>;

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="m-0 text-[13px] font-semibold text-white">
      {children}
    </h2>
  );
}

export function CloudDevicesPanel({
  accountId,
  client,
  sessionLoader = loadSession,
}: {
  accountId: string;
  client?: CloudDevicesClient;
  /** Resolves the signed-in session. Previews inject a synthetic session. */
  sessionLoader?: CloudDevicesSessionLoader;
}) {
  const authClient = useMemo<CloudDevicesClient>(() => client ?? defaultCloudAuthClient(), [client]);
  const cached = cachedDevicesByAccount.get(accountId);
  const [devices, setDevices] = useState<CloudDeviceAuthorization[]>(cached ?? []);
  const [isLoading, setIsLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(null);
  const confirmOperationIds = useRef(new Map<string, string>());

  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) setIsLoading(true);
    try {
      const session = await sessionLoader();
      if (!session?.token || session.accountId !== accountId) {
        throw new Error('The active account session is unavailable. Sign in again.');
      }
      const result = await authClient.listDevices(session.token);
      cachedDevicesByAccount.set(accountId, result.devices);
      setDevices(result.devices);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load active devices.');
    } finally {
      setIsLoading(false);
    }
  }, [accountId, authClient, sessionLoader]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleDeviceChange = (event: Event) => {
      const changedAccountId = (event as CustomEvent<{ accountId?: string }>).detail?.accountId;
      if (!changedAccountId || changedAccountId === accountId) void refresh({ quiet: true });
    };
    window.addEventListener(CLOUD_DEVICES_CHANGED_EVENT, handleDeviceChange);
    window.addEventListener('online', handleDeviceChange);
    return () => {
      window.removeEventListener(CLOUD_DEVICES_CHANGED_EVENT, handleDeviceChange);
      window.removeEventListener('online', handleDeviceChange);
    };
  }, [accountId, refresh]);

  const mutate = async (action: () => Promise<unknown>, affectedIds: string[]) => {
    const before = devices;
    setBusyDeviceId(affectedIds[0] ?? 'others');
    setDevices((current) => current.filter((device) => !affectedIds.includes(device.deviceId)));
    setError(null);
    try {
      await action();
      setConfirmation(null);
      await refresh({ quiet: true });
    } catch (caught) {
      setDevices(before);
      setError(caught instanceof Error ? caught.message : 'Could not update active devices. Try again.');
    } finally {
      setBusyDeviceId(null);
    }
  };

  const confirmDevice = async (device: CloudDeviceAuthorization) => {
    const session = await sessionLoader();
    if (!session?.token || session.accountId !== accountId) {
      setError('The active account session is unavailable. Sign in again.');
      return;
    }
    setBusyDeviceId(device.deviceId);
    setError(null);
    const operationId = confirmOperationIds.current.get(device.deviceId) ?? crypto.randomUUID();
    confirmOperationIds.current.set(device.deviceId, operationId);
    try {
      await authClient.confirmDevice(session.token, device.deviceId, operationId);
      confirmOperationIds.current.delete(device.deviceId);
      await refresh({ quiet: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not confirm this device.');
    } finally {
      setBusyDeviceId(null);
    }
  };

  const executeRevocation = async () => {
    const session = await sessionLoader();
    if (!session?.token || session.accountId !== accountId || !confirmation) {
      setError('The active account session is unavailable. Sign in again.');
      return;
    }
    const token = session.token;
    if (confirmation.kind === 'one') {
      const target = confirmation.device;
      await mutate(
        () => authClient.revokeDevice(token, target.deviceId, confirmation.operationId),
        [target.deviceId],
      );
      return;
    }
    if (confirmation.kind === 'group' || confirmation.kind === 'legacy') {
      const targets = confirmation.kind === 'group' ? confirmation.group.devices : confirmation.devices;
      const { operationIds } = confirmation;
      await mutate(async () => {
        for (const target of targets) {
          const operationId = operationIds.get(target.deviceId) ?? crypto.randomUUID();
          operationIds.set(target.deviceId, operationId);
          await authClient.revokeDevice(token, target.deviceId, operationId);
        }
      }, targets.map((target) => target.deviceId));
      return;
    }
    const affectedIds = devices.filter((device) => !device.currentDevice).map((device) => device.deviceId);
    await mutate(
      () => authClient.revokeOtherDevices(token, confirmation.operationId),
      affectedIds,
    );
  };

  const executeRename = async () => {
    if (!renameRequest) return;
    const displayName = renameRequest.displayName.trim();
    if (!displayName || displayName.length > 80) {
      setError('Enter a device name between 1 and 80 characters.');
      return;
    }
    const session = await sessionLoader();
    if (!session?.token || session.accountId !== accountId) {
      setError('The active account session is unavailable. Sign in again.');
      return;
    }
    const before = devices;
    setBusyDeviceId(renameRequest.device.deviceId);
    setDevices((current) => current.map((device) => (
      device.deviceId === renameRequest.device.deviceId ? { ...device, displayName } : device
    )));
    setError(null);
    try {
      await authClient.renameDevice(
        session.token,
        renameRequest.device.deviceId,
        displayName,
        renameRequest.operationId,
      );
      setRenameRequest(null);
      await refresh({ quiet: true });
    } catch (caught) {
      setDevices(before);
      setError(caught instanceof Error ? caught.message : 'Could not rename this device.');
    } finally {
      setBusyDeviceId(null);
    }
  };

  const { current: currentDevice, groups, legacy } = useMemo(() => groupCloudDevices(devices), [devices]);
  const hasOtherSessions = groups.length > 0 || legacy.length > 0;
  const actionsDisabled = busyDeviceId !== null;

  return (
    <div className="app-cloud-account-settings-section max-w-[680px] py-1">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-semibold text-white">Active sessions</h2>
        <Button
          variant="quiet"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full"
          onClick={() => { void refresh(); }}
          disabled={isLoading}
          aria-label="Refresh active sessions"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </Button>
      </div>

      {error ? (
        <div className="app-error-text mt-4 rounded-[12px] bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100" role="alert">
          {error}
        </div>
      ) : null}

      {isLoading && devices.length === 0 ? (
        <div className="grid min-h-32 place-items-center text-[12px] text-slate-400" role="status">
          Loading…
        </div>
      ) : devices.length === 0 ? (
        <div className="grid min-h-32 place-items-center text-center">
          <div>
            <div className="text-[13px] font-medium text-white">No active sessions.</div>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          {currentDevice ? (
            <section aria-labelledby="current-device-heading">
              <div className="mb-2 flex min-h-8 items-center justify-between gap-3">
                <SectionHeading id="current-device-heading">This device</SectionHeading>
                <Button
                  variant="quiet"
                  className="h-8 rounded-full px-3 text-[11px] text-sky-200 hover:text-sky-100"
                  disabled={actionsDisabled}
                  onClick={() => setRenameRequest({
                    device: currentDevice,
                    displayName: deviceTitle(currentDevice),
                    operationId: crypto.randomUUID(),
                  })}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Rename
                </Button>
              </div>
              <DeviceCard
                highlighted
                icon={<DeviceIcon platform={currentDevice.platform} />}
                title={deviceTitle(currentDevice)}
                subtitle={[
                  platformVersionLabel(currentDevice.platform, currentDevice.osVersion),
                  appVersionLabel(currentDevice.appVersion),
                ].filter(Boolean).join(' · ')}
                status={<StatusLine online lastActiveAt={currentDevice.lastActiveAt} location={currentDevice.approximateLocation} />}
              />
              {hasOtherSessions ? (
                <Button
                  variant="quiet"
                  className="mt-2 h-auto w-full justify-start rounded-[12px] px-3 py-3 text-left text-rose-100 hover:text-rose-50"
                  disabled={actionsDisabled}
                  onClick={() => setConfirmation({
                    kind: 'others',
                    operationId: crypto.randomUUID(),
                  })}
                >
                  <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="text-[12px] font-medium">Log out of all other devices</span>
                </Button>
              ) : (
                <p className="m-0 mt-3 text-[11px] leading-4 text-slate-400">No other devices.</p>
              )}
            </section>
          ) : (
            <div className="rounded-[12px] bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-100" role="status">
              This device is not in the list. Refresh and try again.
            </div>
          )}

          {groups.length > 0 ? (
            <section className="mt-7" aria-labelledby="other-devices-heading">
              <SectionHeading id="other-devices-heading">Other devices</SectionHeading>
              <div className="mt-2 grid gap-2">
                {groups.map((group) => (
                  <DeviceGroupCard
                    key={group.key}
                    group={group}
                    busyDeviceId={busyDeviceId}
                    onConfirmDevice={(device) => { void confirmDevice(device); }}
                    onLogOutDevice={(device) => setConfirmation({ kind: 'one', device, operationId: crypto.randomUUID() })}
                    onLogOutGroup={() => setConfirmation({
                      kind: 'group',
                      group,
                      operationIds: operationIdsFor(group.devices),
                    })}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {legacy.length > 0 ? (
            <section className="mt-7" aria-labelledby="older-sign-ins-heading">
              <SectionHeading id="older-sign-ins-heading">Older sign-ins</SectionHeading>
              <ul className="m-0 mt-2 list-none divide-y divide-white/10 border-y border-white/10 p-0">
                {legacy.map((device) => {
                  const title = `${signInMethodLabel(device.signInMethod)} sign-in`;
                  return (
                    <SessionRow
                      key={device.deviceId}
                      device={device}
                      title={title}
                      busy={busyDeviceId === device.deviceId}
                      onConfirm={() => { void confirmDevice(device); }}
                      logOutLabel={`Log out ${title}`}
                      onLogOut={() => setConfirmation({ kind: 'one', device, operationId: crypto.randomUUID() })}
                    />
                  );
                })}
              </ul>
              <Button
                variant="quiet"
                className="mt-2 h-8 rounded-full px-3 text-[11px] text-rose-100 hover:text-rose-50"
                disabled={actionsDisabled}
                onClick={() => setConfirmation({
                  kind: 'legacy',
                  devices: legacy,
                  operationIds: operationIdsFor(legacy),
                })}
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                Log out of all older sign-ins
              </Button>
            </section>
          ) : null}
        </div>
      )}

      {renameRequest ? (
        <DeviceRenameDialog
          request={renameRequest}
          busy={actionsDisabled}
          onChange={(displayName) => setRenameRequest((current) => (current ? { ...current, displayName } : current))}
          onDismiss={() => setRenameRequest(null)}
          onSave={() => { void executeRename(); }}
        />
      ) : null}

      {confirmation ? (
        <DeviceLogoutDialog
          confirmation={confirmation}
          busy={actionsDisabled}
          onDismiss={() => setConfirmation(null)}
          onConfirm={() => { void executeRevocation(); }}
        />
      ) : null}
    </div>
  );
}
