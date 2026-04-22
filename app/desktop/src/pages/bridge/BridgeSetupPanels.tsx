import { Copy, Download, FolderOpen, LoaderCircle, Plus, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import {
  BridgeHostFields,
  BridgeSetupModeCards,
  NeedHostedBridgeNotice,
} from './BridgeSetupSections';
import type { BridgeSetupPanelProps } from './BridgeConfigPage.types';

export function BridgeStorageInfoCard({
  desktopBridgeState,
  importBridgeConfigInputRef,
  closeSetupComposer,
  onOpenBridgeConfigFolder,
  onRevealBridgeStorageFile,
  onCopyBridgeText,
  onExportBridgeHostsConfig,
  onImportBridgeHostsConfig,
  onRefreshBridge,
  setActiveSection,
}: Pick<
  BridgeSetupPanelProps,
  | 'desktopBridgeState'
  | 'importBridgeConfigInputRef'
  | 'closeSetupComposer'
  | 'onOpenBridgeConfigFolder'
  | 'onRevealBridgeStorageFile'
  | 'onCopyBridgeText'
  | 'onExportBridgeHostsConfig'
  | 'onImportBridgeHostsConfig'
  | 'onRefreshBridge'
  | 'setActiveSection'
>) {
  if (!desktopBridgeState) {
    return null;
  }

  return (
    <Card className="app-bridge-card app-bridge-advanced-card rounded-[22px] border-white/10 bg-white/[0.04] shadow-none">
      <CardContent className="space-y-3 px-4 py-4 text-sm text-slate-300">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[12px] font-medium text-white">Stored on this desktop</div>
            <div className="mt-1 text-[11px] leading-5 text-slate-400">
              Bridge host metadata is stored locally so you can reconnect quickly and inspect the desktop files. Exported JSON is redacted by default, so local bridge credentials stay on this desktop.
            </div>
          </div>
          <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => void onOpenBridgeConfigFolder()}>
            <FolderOpen className="mr-2 h-4 w-4" /> Open config folder
          </Button>
        </div>
        <div className="grid gap-2">
          <StoragePathRow
            label="Bridge hosts config"
            path={desktopBridgeState.configPath}
            revealKind="config"
            copyMessage="Bridge config path copied"
            onRevealBridgeStorageFile={onRevealBridgeStorageFile}
            onCopyBridgeText={onCopyBridgeText}
          />
          <StoragePathRow
            label="Bridge conversations"
            path={desktopBridgeState.conversationsPath}
            revealKind="conversations"
            copyMessage="Bridge conversations path copied"
            onRevealBridgeStorageFile={onRevealBridgeStorageFile}
            onCopyBridgeText={onCopyBridgeText}
          />
          <StoragePathRow
            label="Legacy bridge config"
            path={desktopBridgeState.legacyConfigPath}
            revealKind="legacy"
            copyMessage="Legacy bridge config path copied"
            onRevealBridgeStorageFile={onRevealBridgeStorageFile}
            onCopyBridgeText={onCopyBridgeText}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => void onExportBridgeHostsConfig()}>
            <Download className="mr-2 h-4 w-4" /> Export redacted bridge host config
          </Button>
          <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => importBridgeConfigInputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" /> Import bridge host config
          </Button>
        </div>
        <input
          ref={importBridgeConfigInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            try {
              const raw = await file.text();
              await onImportBridgeHostsConfig(raw);
              await onRefreshBridge();
              closeSetupComposer();
              setActiveSection('servers');
            } catch (error) {
              console.error('Failed to import bridge host config', error);
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

function StoragePathRow({
  label,
  path,
  revealKind,
  copyMessage,
  onRevealBridgeStorageFile,
  onCopyBridgeText,
}: {
  label: string;
  path: string;
  revealKind: 'config' | 'conversations' | 'legacy';
  copyMessage: string;
  onRevealBridgeStorageFile: BridgeSetupPanelProps['onRevealBridgeStorageFile'];
  onCopyBridgeText: BridgeSetupPanelProps['onCopyBridgeText'];
}) {
  return (
    <div className="app-bridge-meta-block app-bridge-inspector-row rounded-[16px] px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
          <div className="mt-1 break-all text-[12px] text-slate-300">{path}</div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" className="rounded-[12px] px-3 text-[11px]" onClick={() => void onRevealBridgeStorageFile(revealKind)}>
            <FolderOpen className="mr-2 h-3.5 w-3.5" /> Reveal file in Finder
          </Button>
          <Button variant="secondary" className="rounded-[12px] px-3 text-[11px]" onClick={() => onCopyBridgeText(path, copyMessage)}>
            <Copy className="mr-2 h-3.5 w-3.5" /> Copy path
          </Button>
        </div>
      </div>
    </div>
  );
}

export function BridgeSetupSection({
  desktopBridgeState,
  activeBridgeHost,
  bridgeSettingsDraft,
  setBridgeSettingsDraft,
  isDesktopBridgeSaving,
  desktopBridgeError,
  setupMode,
  setSetupMode,
  showSetupComposer,
  setShowSetupComposer,
  closeSetupComposer,
  setActiveSection,
  setPendingRemoveHost,
  onCreateBridgeDraft,
  onRefreshBridge,
  onSaveBridgeSettings,
  onSelectBridgeHost,
}: Pick<
  BridgeSetupPanelProps,
  | 'desktopBridgeState'
  | 'activeBridgeHost'
  | 'bridgeSettingsDraft'
  | 'setBridgeSettingsDraft'
  | 'isDesktopBridgeSaving'
  | 'desktopBridgeError'
  | 'setupMode'
  | 'setSetupMode'
  | 'showSetupComposer'
  | 'setShowSetupComposer'
  | 'closeSetupComposer'
  | 'setActiveSection'
  | 'setPendingRemoveHost'
  | 'onCreateBridgeDraft'
  | 'onRefreshBridge'
  | 'onSaveBridgeSettings'
  | 'onSelectBridgeHost'
>) {
  const hosts = desktopBridgeState?.hosts ?? [];

  if (!showSetupComposer) {
    if (hosts.length === 0) {
      return (
        <div className="flex min-h-[420px] items-center justify-center">
          <button
            type="button"
            onClick={() => {
              onCreateBridgeDraft();
              setSetupMode('have-url');
              setShowSetupComposer(true);
            }}
            className="app-bridge-card app-bridge-empty-host-cta flex min-h-[220px] w-full max-w-[420px] flex-col items-center justify-center rounded-[30px] border border-dashed border-white/12 bg-white/[0.04] px-6 py-8 text-center text-white transition hover:bg-white/[0.06]"
          >
            <div className="app-bridge-empty-host-stack">
              <div className="app-bridge-empty-host-icon grid h-12 w-12 place-items-center rounded-full border border-white/12 bg-white/[0.06]">
                <Plus className="h-5 w-5" />
              </div>
              <div className="text-[15px] font-medium">Add bridge host</div>
              <div className="mx-auto max-w-[280px] text-[12px] leading-5 text-slate-400">
                Connect your first hosted bridge server to start collaborating with other people and agents.
              </div>
            </div>
          </button>
        </div>
      );
    }

    return (
      <div className="w-full space-y-3">
        <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">Configured bridge servers</CardTitle>
              <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={onRefreshBridge}>
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-300">
            {hosts.map((host) => (
              <div
                key={host.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  onSelectBridgeHost(host.id);
                  setActiveSection('details');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectBridgeHost(host.id);
                    setActiveSection('details');
                  }
                }}
                className={cn(
                  'app-bridge-list-item w-full rounded-[18px] border px-3 py-3 text-left transition',
                  host.id === activeBridgeHost?.id ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-white">{host.serverUrl}</div>
                    <div className="mt-1 text-[12px] text-slate-400">{host.connected ? 'Connected' : 'Offline'} • {host.visiblePeerCount} visible • {host.ownerName}</div>
                    <div className="mt-1 break-all text-[12px] text-slate-500">Human ID: {host.humanId}</div>
                    <div className="mt-1 break-all text-[12px] text-slate-500">Primary agent: {host.agents.find((agent) => agent.isDefault)?.label || host.displayName}</div>
                  </div>
                  <div className="flex shrink-0 items-start gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-7 rounded-xl px-2.5 text-[11px]"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingRemoveHost(host);
                      }}
                    >
                      Remove
                    </Button>
                    <div className={cn('mt-2 h-2.5 w-2.5 rounded-full', host.connected ? 'bg-emerald-400' : 'bg-slate-500')} />
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="flex justify-center">
          <Button
            variant="secondary"
            className="rounded-[16px] px-4 text-[12px]"
            onClick={() => {
              onCreateBridgeDraft();
              setSetupMode('have-url');
              setShowSetupComposer(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Add new server
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-3">
      <Card className="app-bridge-card app-bridge-panel app-bridge-setup-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">Add or join bridge host</CardTitle>
            <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={closeSetupComposer}>
              Back to servers
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3.5 text-sm text-slate-300">
          <div className="text-[13px] leading-5 text-slate-400">
            Choose whether you already have a hosted Bridges server URL, or whether you need to create one.
          </div>
          {desktopBridgeError ? (
            <div className={cn(
              'rounded-xl px-3 py-2 text-[12px]',
              desktopBridgeError.toLowerCase().includes('copied')
                ? 'border border-cyan-500/20 bg-cyan-500/10 text-cyan-100'
                : 'border border-rose-500/20 bg-rose-500/10 text-rose-100',
            )}>
              {desktopBridgeError}
            </div>
          ) : null}
          <BridgeSetupModeCards mode={setupMode} onChange={setSetupMode} />
          {bridgeSettingsDraft ? setupMode === 'have-url' ? (
            <>
              <BridgeHostFields
                serverUrl={bridgeSettingsDraft.serverUrl}
                ownerName={bridgeSettingsDraft.ownerName}
                onServerUrlChange={(serverUrl) => setBridgeSettingsDraft((current) => current ? { ...current, serverUrl } : current)}
                onOwnerNameChange={(ownerName) => setBridgeSettingsDraft((current) => current ? { ...current, ownerName } : current)}
                inputClassName="app-bridge-field"
                ownerNameHint={(
                  <>
                    Your primary agent name is managed from the <span className="text-slate-300">Agents</span> page.
                  </>
                )}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <Button className="rounded-[14px] text-[12px]" onClick={() => onSaveBridgeSettings()} disabled={isDesktopBridgeSaving || !bridgeSettingsDraft.serverUrl.trim()}>
                  {isDesktopBridgeSaving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {bridgeSettingsDraft.hostId ? 'Save host' : 'Join host'}
                </Button>
              </div>
            </>
          ) : (
            <NeedHostedBridgeNotice
              callout="Bridges is for real collaboration, so you need a hosted bridge server URL that your teammates can actually reach."
              detail="The Kordi server setup guide walks through running Bridges from this Kordi repo on your own VM, cloud machine, or always-on lab machine. Kordi Desktop already bundles the local bridge tooling, so teammates only need the final hosted URL here."
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export function BridgeAdvancedSection({
  activeBridgeHost,
  desktopBridgeState,
  importBridgeConfigInputRef,
  closeSetupComposer,
  onOpenBridgeConfigFolder,
  onRevealBridgeStorageFile,
  onCopyBridgeText,
  onExportBridgeHostsConfig,
  onImportBridgeHostsConfig,
  onRefreshBridge,
  setActiveSection,
}: Pick<
  BridgeSetupPanelProps,
  | 'activeBridgeHost'
  | 'desktopBridgeState'
  | 'importBridgeConfigInputRef'
  | 'closeSetupComposer'
  | 'onOpenBridgeConfigFolder'
  | 'onRevealBridgeStorageFile'
  | 'onCopyBridgeText'
  | 'onExportBridgeHostsConfig'
  | 'onImportBridgeHostsConfig'
  | 'onRefreshBridge'
  | 'setActiveSection'
>) {
  return (
    <div className="w-full space-y-4">
      <Card className="app-bridge-card app-bridge-advanced-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Advanced</CardTitle>
              <div className="mt-1 text-[12px] leading-5 text-slate-400">
                Local storage, Finder tools, and bridge host config import/export live here so the main bridge flow stays focused on collaboration.
              </div>
            </div>
            <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => setActiveSection('servers')}>
              Back to servers
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-300">
          {activeBridgeHost ? (
            <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
              <div className="text-[12px] font-medium text-white">Current server</div>
              <div className="mt-1 break-all text-[12px] text-slate-300">{activeBridgeHost.serverUrl}</div>
              <div className="mt-1 text-[12px] text-slate-500">{activeBridgeHost.ownerName} • {activeBridgeHost.connected ? 'Connected' : 'Offline'}</div>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <BridgeStorageInfoCard
        desktopBridgeState={desktopBridgeState}
        importBridgeConfigInputRef={importBridgeConfigInputRef}
        closeSetupComposer={closeSetupComposer}
        onOpenBridgeConfigFolder={onOpenBridgeConfigFolder}
        onRevealBridgeStorageFile={onRevealBridgeStorageFile}
        onCopyBridgeText={onCopyBridgeText}
        onExportBridgeHostsConfig={onExportBridgeHostsConfig}
        onImportBridgeHostsConfig={onImportBridgeHostsConfig}
        onRefreshBridge={onRefreshBridge}
        setActiveSection={setActiveSection}
      />
    </div>
  );
}
