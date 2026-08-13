import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Laptop, LogOut, Pencil, RefreshCw, ShieldAlert, Smartphone, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import {
  defaultCloudAuthClient,
  type CloudAuthClient,
  type CloudDeviceAuthorization,
} from './authClient';
import { loadSession } from './session';

const cachedDevicesByAccount = new Map<string, CloudDeviceAuthorization[]>();
export const CLOUD_DEVICES_CHANGED_EVENT = 'kordi-cloud-devices-changed';
const sessionDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

type Confirmation =
  | { kind: 'one'; device: CloudDeviceAuthorization; operationId: string }
  | { kind: 'others'; operationId: string };

type RenameRequest = {
  device: CloudDeviceAuthorization;
  displayName: string;
  operationId: string;
};

function deviceTitle(device: CloudDeviceAuthorization): string {
  return device.displayName?.trim()
    || (device.platform === 'ios' ? 'iPhone' : device.platform === 'macos' ? 'Mac' : 'Kordi device');
}

function deviceDetails(device: CloudDeviceAuthorization): string | null {
  return [device.platform, device.osVersion, device.appVersion ? `Kordi ${device.appVersion}` : null]
    .filter(Boolean)
    .join(' · ') || null;
}

function lastActiveDescription(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const elapsed = Math.max(0, Date.now() - date.getTime());
  if (elapsed < 60_000) return 'Active just now';
  if (elapsed < 3_600_000) return `Active ${Math.max(1, Math.floor(elapsed / 60_000))} min ago`;
  if (elapsed < 86_400_000) return `Active ${Math.max(1, Math.floor(elapsed / 3_600_000))} hr ago`;
  return `Last active ${sessionDateFormatter.format(date)}`;
}

function DeviceIcon({ platform }: { platform: string | null }) {
  const Icon = platform === 'ios' ? Smartphone : Laptop;
  return <Icon className="h-4 w-4" aria-hidden="true" />;
}

function DeviceSummary({ device }: { device: CloudDeviceAuthorization }) {
  const details = deviceDetails(device);
  const activity = [device.approximateLocation, lastActiveDescription(device.lastActiveAt)]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  return (
    <>
      {details ? <p className="m-0 mt-1 text-[11px] leading-4 text-slate-400">{details}</p> : null}
      {activity ? <p className="m-0 mt-1 text-[11px] leading-4 text-slate-400">{activity}</p> : null}
    </>
  );
}

export function CloudDevicesPanel({
  accountId,
  client,
}: {
  accountId: string;
  client?: CloudAuthClient;
}) {
  const authClient = useMemo(() => client ?? defaultCloudAuthClient(), [client]);
  const cached = cachedDevicesByAccount.get(accountId);
  const [devices, setDevices] = useState<CloudDeviceAuthorization[]>(cached ?? []);
  const [isLoading, setIsLoading] = useState(!cached);
  const [isStale, setIsStale] = useState(Boolean(cached));
  const [error, setError] = useState<string | null>(null);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(null);
  const confirmOperationIds = useRef(new Map<string, string>());

  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) setIsLoading(true);
    try {
      const session = await loadSession();
      if (!session?.token || session.accountId !== accountId) {
        throw new Error('The active account session is unavailable. Sign in again.');
      }
      const result = await authClient.listDevices(session.token);
      cachedDevicesByAccount.set(accountId, result.devices);
      setDevices(result.devices);
      setError(null);
      setIsStale(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load active devices.');
      setIsStale(cachedDevicesByAccount.has(accountId));
    } finally {
      setIsLoading(false);
    }
  }, [accountId, authClient]);

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
    const session = await loadSession();
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
    const session = await loadSession();
    if (!session?.token || session.accountId !== accountId || !confirmation) {
      setError('The active account session is unavailable. Sign in again.');
      return;
    }
    if (confirmation.kind === 'one') {
      const target = confirmation.device;
      await mutate(
        () => authClient.revokeDevice(
          session.token,
          target.deviceId,
          confirmation.operationId,
        ),
        [target.deviceId],
      );
      return;
    }
    const affectedIds = devices.filter((device) => !device.currentDevice).map((device) => device.deviceId);
    await mutate(
      () => authClient.revokeOtherDevices(session.token, confirmation.operationId),
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
    const session = await loadSession();
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

  const currentDevice = devices.find((device) => device.currentDevice);
  const otherDevices = devices.filter((device) => !device.currentDevice);

  return (
    <div className="app-cloud-account-settings-section max-w-[680px] py-1">
      <div className="flex items-start justify-between gap-4">
        <p className="m-0 max-w-[60ch] text-[12px] leading-5 text-slate-400">
          Review the installations that can access your Cloud account. Terminating a device revokes Kordi access, but cannot erase files already saved on it.
        </p>
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

      {isStale ? (
        <div className="mt-4 rounded-[12px] bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-100" role="status">
          Showing the last device list from this session. Reconnect and refresh to verify changes.
        </div>
      ) : null}
      {error ? (
        <div className="app-error-text mt-4 rounded-[12px] bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100" role="alert">
          {error}
        </div>
      ) : null}

      {isLoading && devices.length === 0 ? (
        <div className="grid min-h-32 place-items-center text-[12px] text-slate-400" role="status">
          Loading active sessions…
        </div>
      ) : devices.length === 0 ? (
        <div className="grid min-h-32 place-items-center text-center">
          <div>
            <div className="text-[13px] font-medium text-white">No active sessions found</div>
            <div className="mt-1 text-[12px] leading-5 text-slate-400">Refresh the list, or sign in again if this device is missing.</div>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          {currentDevice ? (
            <section aria-labelledby="current-device-heading">
              <div className="mb-2 flex min-h-8 items-center justify-between gap-3">
                <h2 id="current-device-heading" className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                  This device
                </h2>
                <Button
                  variant="quiet"
                  className="h-8 rounded-full px-3 text-[11px] text-sky-200 hover:text-sky-100"
                  disabled={busyDeviceId !== null}
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
              <div className="border-y border-white/10 py-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sky-400/10 text-sky-200">
                    <DeviceIcon platform={currentDevice.platform} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="m-0 truncate text-[13px] font-medium text-white">{deviceTitle(currentDevice)}</h3>
                    <DeviceSummary device={currentDevice} />
                  </div>
                </div>
              </div>
              {otherDevices.length > 0 ? (
                <Button
                  variant="quiet"
                  className="mt-2 h-auto w-full justify-start rounded-[12px] px-3 py-3 text-left text-rose-100 hover:text-rose-50"
                  disabled={busyDeviceId !== null}
                  onClick={() => setConfirmation({
                    kind: 'others',
                    operationId: crypto.randomUUID(),
                  })}
                >
                  <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 whitespace-normal">
                    <span className="block text-[12px] font-medium">Terminate all other sessions</span>
                    <span className="mt-0.5 block text-[11px] font-normal leading-4 text-slate-400">Signs out every other device except this one.</span>
                  </span>
                </Button>
              ) : (
                <p className="m-0 mt-3 text-[11px] leading-4 text-slate-400">No other active sessions are connected to this account.</p>
              )}
            </section>
          ) : (
            <div className="rounded-[12px] bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-100" role="status">
              Kordi could not identify this device in the active session list. Refresh before terminating another session.
            </div>
          )}

          <section className="mt-7" aria-labelledby="other-devices-heading">
            <h2 id="other-devices-heading" className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
              Active devices
            </h2>
            {otherDevices.length === 0 ? (
              <p className="m-0 mt-3 border-t border-white/10 pt-4 text-[12px] leading-5 text-slate-400">Your other devices will appear here after they sign in.</p>
            ) : (
              <div className="mt-2 divide-y divide-white/10 border-y border-white/10">
                {otherDevices.map((device) => {
                  const pending = device.authorizationState === 'pending_review';
                  const busy = busyDeviceId === device.deviceId;
                  return (
                    <article key={device.deviceId} className="py-4" aria-label={deviceTitle(device)}>
                      <div className="flex items-start gap-3">
                        <div className={cn(
                          'mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/[0.06] text-slate-300',
                          pending && 'bg-amber-500/10 text-amber-200',
                        )}>
                          {pending ? <ShieldAlert className="h-4 w-4" aria-hidden="true" /> : <DeviceIcon platform={device.platform} />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <h3 className="m-0 truncate text-[13px] font-medium text-white">{deviceTitle(device)}</h3>
                            {pending ? (
                              <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-100">Needs review</span>
                            ) : null}
                          </div>
                          <DeviceSummary device={device} />
                          {pending ? (
                            <Button
                              variant="secondary"
                              className="mt-3 h-8 rounded-full px-3 text-[11px]"
                              disabled={busy}
                              onClick={() => { void confirmDevice(device); }}
                            >
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              This was me
                            </Button>
                          ) : null}
                        </div>
                        <Button
                          variant="quiet"
                          size="icon"
                          className="h-8 w-8 shrink-0 rounded-full text-slate-500 hover:text-rose-200"
                          disabled={busy}
                          aria-label={`Terminate ${deviceTitle(device)}`}
                          onClick={() => setConfirmation({
                            kind: 'one',
                            device,
                            operationId: crypto.randomUUID(),
                          })}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <p className="m-0 mt-5 text-[11px] leading-4 text-slate-500">
            Termination revokes Kordi Cloud access, but cannot erase files already saved on another device.
          </p>
        </div>
      )}

      {renameRequest ? (
        <AppDialog
          titleId="device-rename-title"
          descriptionId="device-rename-description"
          onDismiss={() => setRenameRequest(null)}
          dismissDisabled={busyDeviceId !== null}
          busy={busyDeviceId !== null}
          className="max-w-md rounded-[20px]"
          backdropClassName="!z-[100000]"
        >
          <AppDialogTitle id="device-rename-title">Rename this device</AppDialogTitle>
          <AppDialogDescription id="device-rename-description">
            Use a name that helps you recognize this session in Kordi.
          </AppDialogDescription>
          <label className="mt-4 block text-[11px] font-medium text-slate-300" htmlFor="device-display-name">
            Device name
          </label>
          <input
            id="device-display-name"
            className="app-input-shell mt-2 h-10 w-full rounded-[12px] px-3 text-[13px] text-white outline-none"
            value={renameRequest.displayName}
            maxLength={80}
            autoFocus
            disabled={busyDeviceId !== null}
            onChange={(event) => setRenameRequest((current) => (
              current ? { ...current, displayName: event.currentTarget.value } : current
            ))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void executeRename();
              }
            }}
          />
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" disabled={busyDeviceId !== null} onClick={() => setRenameRequest(null)}>Cancel</Button>
            <Button className="rounded-full px-4" disabled={busyDeviceId !== null || !renameRequest.displayName.trim()} onClick={() => { void executeRename(); }}>
              {busyDeviceId !== null ? 'Saving…' : 'Save'}
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}

      {confirmation ? (
        <AppDialog
          titleId="device-revocation-title"
          descriptionId="device-revocation-description"
          onDismiss={() => setConfirmation(null)}
          dismissDisabled={busyDeviceId !== null}
          busy={busyDeviceId !== null}
          className="max-w-md rounded-[20px]"
          backdropClassName="!z-[100000]"
        >
          <AppDialogTitle id="device-revocation-title">
            {confirmation.kind === 'one' ? `Terminate ${deviceTitle(confirmation.device)}?` : 'Terminate all other sessions?'}
          </AppDialogTitle>
          <AppDialogDescription id="device-revocation-description">
            Kordi will revoke every Cloud session on {confirmation.kind === 'one' ? 'this device' : 'the other devices'}. Local files already stored there will not be erased.
          </AppDialogDescription>
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={busyDeviceId !== null} onClick={() => setConfirmation(null)}>Cancel</Button>
            <Button className="rounded-full bg-rose-500 px-4 text-white hover:bg-rose-400" disabled={busyDeviceId !== null} onClick={() => { void executeRevocation(); }}>
              {busyDeviceId !== null ? 'Terminating…' : 'Terminate access'}
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}
    </div>
  );
}
