import type { ReactNode } from 'react';
import { Check, KeyRound, Laptop, LogOut, Monitor, ShieldAlert, Smartphone, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { CloudDeviceAuthorization } from './cloudDeviceClient';
import {
  appVersionLabel,
  isPendingReview,
  lastActiveDescription,
  platformVersionLabel,
  sessionCountLabel,
  type CloudDeviceGroup,
} from './cloudDeviceGroups';

export function DeviceIcon({ platform, legacy = false }: { platform: string | null; legacy?: boolean }) {
  const normalized = platform?.toLowerCase();
  const Icon = legacy
    ? KeyRound
    : normalized === 'ios'
      ? Smartphone
      : normalized === 'windows' || normalized === 'linux'
        ? Monitor
        : Laptop;
  return <Icon className="h-4 w-4" aria-hidden="true" />;
}

/** "Active now" with a green dot when online, otherwise the last activity time. */
export function StatusLine({
  online,
  lastActiveAt,
  location,
}: {
  online: boolean;
  lastActiveAt: string | null;
  location?: string | null;
}) {
  const activity = online ? null : lastActiveDescription(lastActiveAt);
  return (
    <p className="m-0 mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-slate-400">
      {online ? (
        <span className="inline-flex items-center gap-1.5 text-emerald-200">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          Active now
        </span>
      ) : activity ? <span>{activity}</span> : null}
      {location ? (
        <>
          {online || activity ? <span aria-hidden="true">·</span> : null}
          <span>{location}</span>
        </>
      ) : null}
    </p>
  );
}

export function NeedsReviewChip() {
  return (
    <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-100">Needs review</span>
  );
}

export function ConfirmDeviceButton({
  disabled,
  onConfirm,
  compact = false,
}: {
  disabled: boolean;
  onConfirm: () => void;
  compact?: boolean;
}) {
  return (
    <Button
      variant="secondary"
      className={cn('h-8 rounded-full px-3 text-[11px]', compact ? 'h-7 px-2.5' : 'mt-3')}
      disabled={disabled}
      onClick={onConfirm}
    >
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
      This was me
    </Button>
  );
}

export function LogOutIconButton({
  label,
  disabled,
  onClick,
  compact = false,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <Button
      variant="quiet"
      size="icon"
      className={cn(
        'shrink-0 rounded-full text-slate-500 hover:text-rose-200',
        compact ? 'h-7 w-7' : 'h-8 w-8',
      )}
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
    >
      <X className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} aria-hidden="true" />
    </Button>
  );
}

/** Card frame shared by the current device, device groups, and the older sign-ins list. */
export function DeviceCard({
  icon,
  title,
  label,
  subtitle,
  status,
  chips,
  trailing,
  pending = false,
  highlighted = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  label?: string;
  subtitle?: string | null;
  status?: ReactNode;
  chips?: ReactNode;
  trailing?: ReactNode;
  pending?: boolean;
  highlighted?: boolean;
  children?: ReactNode;
}) {
  return (
    <article className="rounded-[14px] border border-white/10 bg-white/[0.02] px-4 py-3.5" aria-label={label ?? title}>
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/[0.06] text-slate-300',
            highlighted && 'bg-sky-400/10 text-sky-200',
            pending && 'bg-amber-500/10 text-amber-200',
          )}
        >
          {pending ? <ShieldAlert className="h-4 w-4" aria-hidden="true" /> : icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="m-0 truncate text-[13px] font-medium text-white">{title}</h3>
            {chips}
          </div>
          {subtitle ? <p className="m-0 mt-1 text-[11px] leading-4 text-slate-400">{subtitle}</p> : null}
          {status}
        </div>
        {trailing}
      </div>
      {children}
    </article>
  );
}

/** Compact row for one session inside a multi-session device card. */
export function SessionRow({
  device,
  title,
  busy,
  onConfirm,
  onLogOut,
  logOutLabel,
}: {
  device: CloudDeviceAuthorization;
  title?: string;
  busy: boolean;
  onConfirm?: () => void;
  onLogOut: () => void;
  logOutLabel: string;
}) {
  const pending = isPendingReview(device);
  const details = [lastActiveDescription(device.lastActiveAt), title ? device.approximateLocation : null]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  return (
    <li className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-[12px] font-medium text-slate-200">{title ?? appVersionLabel(device.appVersion)}</span>
          {device.online ? (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-label="Online" />
          ) : null}
          {pending ? <NeedsReviewChip /> : null}
        </div>
        {details ? <p className="m-0 mt-0.5 text-[11px] leading-4 text-slate-400">{details}</p> : null}
      </div>
      {pending && onConfirm ? <ConfirmDeviceButton compact disabled={busy} onConfirm={onConfirm} /> : null}
      <LogOutIconButton compact label={logOutLabel} disabled={busy} onClick={onLogOut} />
    </li>
  );
}

/** One physical device: an inline log-out for a single session, or a session list with a group log-out. */
export function DeviceGroupCard({
  group,
  busyDeviceId,
  onConfirmDevice,
  onLogOutDevice,
  onLogOutGroup,
}: {
  group: CloudDeviceGroup;
  busyDeviceId: string | null;
  onConfirmDevice: (device: CloudDeviceAuthorization) => void;
  onLogOutDevice: (device: CloudDeviceAuthorization) => void;
  onLogOutGroup: () => void;
}) {
  const actionsDisabled = busyDeviceId !== null;
  const subtitle = [
    platformVersionLabel(group.platform, group.osVersion),
    group.sessionCount > 1 ? sessionCountLabel(group.sessionCount) : null,
  ].filter(Boolean).join(' · ');
  const single = group.devices.length === 1 ? group.devices[0] : null;
  const singleBusy = single ? busyDeviceId === single.deviceId : false;
  return (
    <DeviceCard
      icon={<DeviceIcon platform={group.platform} />}
      title={group.title}
      subtitle={subtitle}
      pending={group.pending}
      chips={group.pending ? <NeedsReviewChip /> : null}
      status={<StatusLine online={group.online} lastActiveAt={group.lastActiveAt} location={group.location} />}
      trailing={single ? (
        <LogOutIconButton
          label={`Log out ${group.title}`}
          disabled={singleBusy || actionsDisabled}
          onClick={() => onLogOutDevice(single)}
        />
      ) : null}
    >
      {single ? (
        isPendingReview(single) ? (
          <div className="pl-12">
            <ConfirmDeviceButton disabled={singleBusy} onConfirm={() => onConfirmDevice(single)} />
          </div>
        ) : null
      ) : (
        <div className="mt-3 pl-12">
          <ul className="m-0 list-none divide-y divide-white/10 border-y border-white/10 p-0">
            {group.devices.map((device) => (
              <SessionRow
                key={device.deviceId}
                device={device}
                busy={busyDeviceId === device.deviceId}
                onConfirm={() => onConfirmDevice(device)}
                logOutLabel={`Log out ${appVersionLabel(device.appVersion)} on ${group.title}`}
                onLogOut={() => onLogOutDevice(device)}
              />
            ))}
          </ul>
          <Button
            variant="quiet"
            className="mt-2 h-8 rounded-full px-3 text-[11px] text-rose-100 hover:text-rose-50"
            disabled={actionsDisabled}
            onClick={onLogOutGroup}
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Log out of this device
          </Button>
        </div>
      )}
    </DeviceCard>
  );
}
