import type { ReactNode } from 'react';
import { Check, KeyRound, Laptop, Monitor, ShieldAlert, Smartphone, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { CloudDeviceAuthorization } from './cloudDeviceClient';
import {
  appVersionLabel,
  deviceRowTitle,
  isLegacyDevice,
  isPendingReview,
  lastActiveDescription,
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

function ActiveNow() {
  return (
    <span className="inline-flex items-center gap-1.5 text-emerald-200">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
      Active now
    </span>
  );
}

/** One muted line of details joined by dots; "Active now" gets a green dot. */
export function MetaLine({ parts, online = false }: { parts: Array<string | null | undefined>; online?: boolean }) {
  const text = parts.filter((part): part is string => Boolean(part));
  if (!online && text.length === 0) return null;
  return (
    <p className="m-0 mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-slate-400">
      {text.map((part, index) => (
        <span key={`${index}-${part}`} className="contents">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          <span>{part}</span>
        </span>
      ))}
      {online ? (
        <>
          {text.length > 0 ? <span aria-hidden="true">·</span> : null}
          <ActiveNow />
        </>
      ) : null}
    </p>
  );
}

function Badge({ tone, children }: { tone: 'amber'; children: string }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', tone === 'amber' && 'bg-amber-400/10 text-amber-100')}>
      {children}
    </span>
  );
}

export function NeedsReviewBadge() {
  return <Badge tone="amber">Needs review</Badge>;
}

export function WaitingForApprovalBadge() {
  return <Badge tone="amber">Waiting for approval</Badge>;
}

function IconCircle({ pending, highlighted = false, children }: { pending: boolean; highlighted?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/[0.06] text-slate-300',
        highlighted && 'bg-sky-400/10 text-sky-200',
        pending && 'bg-amber-500/10 text-amber-200',
      )}
    >
      {pending ? <ShieldAlert className="h-4 w-4" aria-hidden="true" /> : children}
    </div>
  );
}

/** The current device card. */
export function CurrentDeviceCard({
  device,
  title,
  details,
  note,
}: {
  device: CloudDeviceAuthorization;
  title: string;
  details: string | null;
  note: string | null;
}) {
  const pending = isPendingReview(device);
  return (
    <article className="rounded-[14px] border border-white/10 bg-white/[0.02] px-4 py-3.5" aria-label={title}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <IconCircle pending={pending} highlighted>
            <DeviceIcon platform={device.platform} />
          </IconCircle>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="m-0 truncate text-[13px] font-medium text-white">{title}</h3>
            {pending ? <WaitingForApprovalBadge /> : null}
          </div>
          {details ? <p className="m-0 mt-1 text-[11px] leading-4 text-slate-400">{details}</p> : null}
          {pending ? (
            note ? <p className="m-0 mt-1 text-[11px] leading-4 text-slate-400">{note}</p> : null
          ) : (
            <MetaLine parts={[device.approximateLocation]} online />
          )}
        </div>
      </div>
    </article>
  );
}

/** One flat row for another device or installation. */
export function DeviceRow({
  device,
  busy,
  actionsHidden,
  onConfirm,
  onLogOut,
}: {
  device: CloudDeviceAuthorization;
  busy: boolean;
  /** Hidden while the current device itself still waits for approval. */
  actionsHidden: boolean;
  onConfirm: () => void;
  onLogOut: () => void;
}) {
  const pending = isPendingReview(device);
  const title = deviceRowTitle(device);
  const online = device.online === true;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <IconCircle pending={pending}>
        <DeviceIcon platform={device.platform} legacy={isLegacyDevice(device)} />
      </IconCircle>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-[13px] font-medium text-white">{title}</span>
          {pending ? <NeedsReviewBadge /> : null}
        </div>
        <MetaLine
          parts={[
            device.appVersion ? appVersionLabel(device.appVersion) : null,
            device.approximateLocation,
            online ? null : lastActiveDescription(device.lastActiveAt),
          ]}
          online={online}
        />
      </div>
      {actionsHidden ? null : (
        <div className="flex shrink-0 items-center gap-1">
          {pending ? (
            <Button variant="secondary" className="h-7 rounded-full px-2.5 text-[11px]" disabled={busy} onClick={onConfirm}>
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              This was me
            </Button>
          ) : null}
          <Button
            variant="quiet"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-full text-slate-500 hover:text-rose-200"
            disabled={busy}
            aria-label={`Log out ${title}`}
            onClick={onLogOut}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </li>
  );
}
