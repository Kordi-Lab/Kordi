import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  BRIDGE_HOST_URL_PLACEHOLDER,
  BRIDGE_SELF_HOST_GUIDE_URL,
  BRIDGE_SOURCE_URL,
} from '@/features/bridge/constants';
import { openDesktopExternalUrl } from '@/lib/desktop';
import { cn } from '@/lib/utils';

export type BridgeSetupMode = 'have-url' | 'need-host';

type BridgeSetupModeCardsProps = {
  mode: BridgeSetupMode;
  onChange: (mode: BridgeSetupMode) => void;
};

export function BridgeSetupModeCards({
  mode,
  onChange,
}: BridgeSetupModeCardsProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <button
        type="button"
        onClick={() => onChange('have-url')}
        className={cn(
          'rounded-[18px] border px-3 py-3 text-left transition',
          mode === 'have-url'
            ? 'border-white/20 bg-white/[0.08]'
            : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
        )}
      >
        <div className="text-[12px] font-medium text-white">
          I have a bridge host URL
        </div>
        <div className="mt-1 text-[11px] leading-5 text-slate-400">
          Paste the hosted service URL and connect this desktop to it.
        </div>
      </button>
      <button
        type="button"
        onClick={() => onChange('need-host')}
        className={cn(
          'rounded-[18px] border px-3 py-3 text-left transition',
          mode === 'need-host'
            ? 'border-white/20 bg-white/[0.08]'
            : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
        )}
      >
        <div className="text-[12px] font-medium text-white">
          I need to start a new host
        </div>
        <div className="mt-1 text-[11px] leading-5 text-slate-400">
          Use the Kordi guide to host the server, then come back with the final hosted URL.
        </div>
      </button>
    </div>
  );
}

type BridgeHostFieldsProps = {
  serverUrl: string;
  ownerName: string;
  onServerUrlChange: (value: string) => void;
  onOwnerNameChange: (value: string) => void;
  inputClassName?: string;
  serverUrlHint?: ReactNode;
  ownerNameHint?: ReactNode;
};

export function BridgeHostFields({
  serverUrl,
  ownerName,
  onServerUrlChange,
  onOwnerNameChange,
  inputClassName,
  serverUrlHint,
  ownerNameHint,
}: BridgeHostFieldsProps) {
  return (
    <>
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-white">Bridge host URL</div>
        <input
          value={serverUrl}
          onChange={(event) => onServerUrlChange(event.target.value)}
          className={cn(
            'app-input-shell w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none',
            inputClassName,
          )}
          placeholder={BRIDGE_HOST_URL_PLACEHOLDER}
        />
        <div className="mt-2 text-[11px] leading-5 text-slate-500">
          {serverUrlHint ?? (
            <>
              Use the final public hosted URL here. Remote bridge hosts should use{' '}
              <span className="text-slate-300">https://</span>.
            </>
          )}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-white">Your name</div>
        <input
          value={ownerName}
          onChange={(event) => onOwnerNameChange(event.target.value)}
          className={cn(
            'app-input-shell w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none',
            inputClassName,
          )}
          placeholder="Your name"
        />
        <div className="mt-2 text-[11px] leading-5 text-slate-500">
          {ownerNameHint}
        </div>
      </div>
    </>
  );
}

type BridgeDocsActionsProps = {
  className?: string;
  buttonClassName?: string;
  guideLabel?: string;
  sourceLabel?: string;
};

export function BridgeDocsActions({
  className,
  buttonClassName,
  guideLabel = 'Open server setup guide',
  sourceLabel = 'Open Kordi Bridges source',
}: BridgeDocsActionsProps) {
  return (
    <div className={className ?? 'flex flex-wrap gap-2'}>
      <Button
        variant="secondary"
        className={cn('rounded-[14px] text-[12px]', buttonClassName)}
        onClick={() => {
          void openDesktopExternalUrl(BRIDGE_SELF_HOST_GUIDE_URL);
        }}
      >
        <ExternalLink className="mr-2 h-4 w-4" /> {guideLabel}
      </Button>
      <Button
        variant="secondary"
        className={cn('rounded-[14px] text-[12px]', buttonClassName)}
        onClick={() => {
          void openDesktopExternalUrl(BRIDGE_SOURCE_URL);
        }}
      >
        {sourceLabel}
      </Button>
    </div>
  );
}

type NeedHostedBridgeNoticeProps = {
  callout: ReactNode;
  detail: ReactNode;
};

export function NeedHostedBridgeNotice({
  callout,
  detail,
}: NeedHostedBridgeNoticeProps) {
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-[12px] leading-5 text-amber-100">
        {callout}
      </div>
      <div className="text-[12px] leading-5 text-slate-400">{detail}</div>
      <BridgeDocsActions />
    </div>
  );
}
