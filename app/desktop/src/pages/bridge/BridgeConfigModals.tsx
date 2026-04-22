import { LoaderCircle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DesktopBridgeHost } from '@/kordi-app/types';

import {
  BridgeDocsActions,
  BridgeHostFields,
  BridgeSetupModeCards,
  NeedHostedBridgeNotice,
} from './BridgeSetupSections';
import { discoveryLabel } from './BridgeConfigShared';
import type { BridgeConfigPageProps } from './BridgeConfigPage.types';

export function BridgeRemoveHostModal({
  pendingRemoveHost,
  isRemovingHost,
  setPendingRemoveHost,
  setIsRemovingHost,
  onRemoveBridgeHost,
  onRefreshBridge,
}: {
  pendingRemoveHost: DesktopBridgeHost | null;
  isRemovingHost: boolean;
  setPendingRemoveHost: (host: DesktopBridgeHost | null) => void;
  setIsRemovingHost: (value: boolean) => void;
  onRemoveBridgeHost: BridgeConfigPageProps['onRemoveBridgeHost'];
  onRefreshBridge: BridgeConfigPageProps['onRefreshBridge'];
}) {
  if (!pendingRemoveHost) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[color:var(--app-overlay-bg)] px-6 py-8 backdrop-blur-[10px]" style={{ WebkitAppRegion: 'no-drag' as const }}>
      <div className="app-modal-panel w-full max-w-[420px] rounded-[24px] border border-white/10 p-[18px] text-white shadow-[var(--app-shadow-float)]">
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Remove host</div>
          <div className="mt-1 text-[18px] font-semibold">Remove this host from this Mac?</div>
          <div className="mt-2 break-all text-[12px] leading-5 text-slate-400">{pendingRemoveHost.serverUrl}</div>
        </div>
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2.5 text-[12px] leading-5 text-rose-100">
          This removes the host from this desktop and clears the local bridge conversations saved for it.
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            type="button"
            className="rounded-[14px]"
            style={{ WebkitAppRegion: 'no-drag' as const }}
            onClick={() => setPendingRemoveHost(null)}
            disabled={isRemovingHost}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="rounded-[14px]"
            style={{ WebkitAppRegion: 'no-drag' as const }}
            disabled={isRemovingHost}
            onClick={async () => {
              const removingHost = pendingRemoveHost;
              if (!removingHost) return;

              setPendingRemoveHost(null);
              try {
                setIsRemovingHost(true);
                await onRemoveBridgeHost(removingHost.id);
                await onRefreshBridge();
              } catch (error) {
                console.error('Failed to remove bridge host', error);
              } finally {
                setIsRemovingHost(false);
              }
            }}
          >
            {isRemovingHost ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

export function BridgeWizardModal({
  bridgeWizardOpen,
  setBridgeWizardOpen,
  bridgeWizardStep,
  setBridgeWizardStep,
  bridgeWizardDraft,
  setBridgeWizardDraft,
  activeBridgeHost,
  activeDefaultAgentId,
  onBridgeWizardPrimary,
}: {
  bridgeWizardOpen: boolean;
  setBridgeWizardOpen: BridgeConfigPageProps['setBridgeWizardOpen'];
  bridgeWizardStep: BridgeConfigPageProps['bridgeWizardStep'];
  setBridgeWizardStep: BridgeConfigPageProps['setBridgeWizardStep'];
  bridgeWizardDraft: BridgeConfigPageProps['bridgeWizardDraft'];
  setBridgeWizardDraft: BridgeConfigPageProps['setBridgeWizardDraft'];
  activeBridgeHost: BridgeConfigPageProps['activeBridgeHost'];
  activeDefaultAgentId: string | null;
  onBridgeWizardPrimary: BridgeConfigPageProps['onBridgeWizardPrimary'];
}) {
  if (!bridgeWizardOpen) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[color:var(--app-overlay-bg)] px-6 py-8 backdrop-blur-[10px]" style={{ WebkitAppRegion: 'no-drag' as const }}>
      <div className="app-modal-panel app-bridge-wizard-panel w-full max-w-[620px] rounded-[24px] border border-white/10 p-[18px] text-white shadow-[var(--app-shadow-float)]">
        <div className="mb-3.5 flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Bridge setup</div>
            <div className="mt-1 text-[19px] font-semibold">Connect a host in three steps</div>
          </div>
          <button type="button" className="app-icon-button rounded-full p-2 text-slate-300 transition hover:text-white" onClick={() => setBridgeWizardOpen(false)}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="app-bridge-wizard-stepper mb-3.5 flex items-center gap-2 text-[11px] text-slate-400">
          {[1, 2, 3].map((step) => (
            <div key={step} className={cn('flex items-center gap-2', step < 3 ? 'flex-1' : '')}>
              <div className={cn('app-bridge-wizard-step grid h-6 w-6 place-items-center rounded-full border text-[11px]', bridgeWizardStep >= step ? 'border-white/20 bg-white/[0.08] text-white' : 'border-white/10 text-slate-500')}>
                {step}
              </div>
              {step < 3 ? <div className={cn('h-px flex-1', bridgeWizardStep > step ? 'bg-white/20' : 'bg-white/10')} /> : null}
            </div>
          ))}
        </div>
        <div className="space-y-3.5">
          {bridgeWizardStep === 1 ? (
            <>
              <BridgeSetupModeCards
                mode={bridgeWizardDraft.mode}
                onChange={(mode) => setBridgeWizardDraft((current) => ({ ...current, mode }))}
              />
              {bridgeWizardDraft.mode === 'have-url' ? (
                <BridgeHostFields
                  serverUrl={bridgeWizardDraft.serverUrl}
                  ownerName={bridgeWizardDraft.ownerName}
                  onServerUrlChange={(serverUrl) => setBridgeWizardDraft((current) => ({ ...current, serverUrl }))}
                  onOwnerNameChange={(ownerName) => setBridgeWizardDraft((current) => ({ ...current, ownerName }))}
                  ownerNameHint={(
                    <>
                      Agent naming happens later from the <span className="text-slate-300">Agents</span> page.
                    </>
                  )}
                />
              ) : (
                <NeedHostedBridgeNotice
                  callout="You need a hosted bridge URL before this desktop can join a shared host."
                  detail="Start with the Kordi host setup guide if you want to configure the stack yourself. Kordi Desktop already bundles the local bridge tooling, so once the host exists you only come back here with the final URL."
                />
              )}
            </>
          ) : null}
          {bridgeWizardStep === 2 ? (
            bridgeWizardDraft.mode === 'have-url' ? (
              <div className="space-y-3">
                <div className="text-[12px] leading-5 text-slate-400">Host connected. Kordi created a human identity and a default bridge agent for this desktop.</div>
                <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-4">
                  <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[12px] text-slate-300">
                    <div className="font-medium text-white">Host</div>
                    <div className="mt-1 break-all text-slate-400">{activeBridgeHost?.serverUrl || bridgeWizardDraft.serverUrl || 'Not connected yet'}</div>
                  </div>
                  <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[12px] text-slate-300">
                    <div className="font-medium text-white">Human ID</div>
                    <div className="mt-1 break-all text-slate-400">{activeBridgeHost?.humanId || 'Pending'}</div>
                  </div>
                  <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[12px] text-slate-300">
                    <div className="font-medium text-white">Default agent</div>
                    <div className="mt-1 break-all text-slate-400">{activeDefaultAgentId || 'Pending'}</div>
                  </div>
                  <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[12px] text-slate-300">
                    <div className="font-medium text-white">Discovery</div>
                    <div className="mt-1 text-slate-400">{discoveryLabel(activeBridgeHost?.discoveryMode)}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[12px] leading-5 text-slate-300">
                  Next step: finish setting up the hosted bridge, then return here with the final URL. Kordi Desktop already includes the local bridge sidecar, so no extra client install is required just to connect.
                </div>
                <BridgeDocsActions
                  className="grid gap-2.5 md:grid-cols-2"
                  buttonClassName="justify-center"
                  guideLabel="Host setup guide"
                />
              </div>
            )
          ) : null}
          {bridgeWizardStep === 3 ? (
            <div className="space-y-3">
              <div className={cn(
                'app-bridge-meta-block rounded-2xl px-3 py-2.5 text-[12px]',
                bridgeWizardDraft.mode === 'have-url'
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
                  : 'border border-white/10 bg-white/[0.04] text-slate-300',
              )}>
                {bridgeWizardDraft.mode === 'have-url' ? 'This host is ready to use.' : 'Once your hosted bridge is ready, come back and connect it here.'}
              </div>
              <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[12px] leading-5 text-slate-300">
                {bridgeWizardDraft.mode === 'have-url'
                  ? 'Next: confirm how you appear, choose a default agent, then start discovering people and agents on this host.'
                  : 'You do not need to enter a URL in this wizard yet. Finish the hosting flow first, then return with the final hosted service URL.'}
              </div>
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button
            variant="secondary"
            className="rounded-[14px]"
            onClick={() => {
              if (bridgeWizardStep === 1) {
                setBridgeWizardOpen(false);
              } else {
                setBridgeWizardStep((current) => Math.max(1, current - 1) as 1 | 2 | 3);
              }
            }}
          >
            Back
          </Button>
          <Button className="rounded-[14px]" onClick={onBridgeWizardPrimary} disabled={bridgeWizardStep === 1 && bridgeWizardDraft.mode === 'have-url' && !bridgeWizardDraft.serverUrl.trim()}>
            {bridgeWizardStep === 3 ? 'Done' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
}
