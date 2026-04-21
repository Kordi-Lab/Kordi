import type { Dispatch, SetStateAction } from 'react';
import {
  Activity,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  LoaderCircle,
  Plus,
  Square,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { DesktopBridgeHost, DesktopBridgePeer, DesktopBridgeState } from '@/kordi-app/types';

type BridgeSettingsDraft = {
  hostId?: string | null;
  serverUrl: string;
  displayName: string;
  ownerName: string;
};

type BridgeWizardDraft = {
  mode: 'join' | 'self-host' | 'public';
  serverUrl: string;
  displayName: string;
  ownerName: string;
};

type BridgeConfigPageProps = {
  desktopBridgeState: DesktopBridgeState | null;
  activeBridgeHost: DesktopBridgeHost | null;
  activeBridgePeople: DesktopBridgePeer[];
  activeBridgeAgents: DesktopBridgePeer[];
  bridgeSettingsDraft: BridgeSettingsDraft | null;
  setBridgeSettingsDraft: Dispatch<SetStateAction<BridgeSettingsDraft | null>>;
  isDesktopBridgeSaving: boolean;
  desktopBridgeError: string | null;
  bridgeWizardOpen: boolean;
  setBridgeWizardOpen: Dispatch<SetStateAction<boolean>>;
  bridgeWizardStep: 1 | 2 | 3;
  setBridgeWizardStep: Dispatch<SetStateAction<1 | 2 | 3>>;
  bridgeWizardDraft: BridgeWizardDraft;
  setBridgeWizardDraft: Dispatch<SetStateAction<BridgeWizardDraft>>;
  onSelectBridgeHost: (hostId: string) => void;
  onOpenBridgeWizard: (mode?: 'join' | 'self-host' | 'public') => void;
  onCreateBridgeDraft: () => void;
  onStartLocalHost: () => void;
  onStopLocalHost: () => void;
  onRefreshBridge: () => void;
  onSaveBridgeSettings: () => void;
  onRemoveBridgeHost: (hostId: string) => void;
  onCopyBridgeText: (value: string, successMessage?: string) => void;
  onOpenBridgeConversation: (
    hostId: string,
    peerNodeId: string,
    peerDisplayName?: string | null,
    peerOwnerName?: string | null,
    peerRuntime?: string | null,
  ) => void;
  onBridgeWizardPrimary: () => void;
};

export function BridgeConfigPage({
  desktopBridgeState,
  activeBridgeHost,
  activeBridgePeople,
  activeBridgeAgents,
  bridgeSettingsDraft,
  setBridgeSettingsDraft,
  isDesktopBridgeSaving,
  desktopBridgeError,
  bridgeWizardOpen,
  setBridgeWizardOpen,
  bridgeWizardStep,
  setBridgeWizardStep,
  bridgeWizardDraft,
  setBridgeWizardDraft,
  onSelectBridgeHost,
  onOpenBridgeWizard,
  onCreateBridgeDraft,
  onStartLocalHost,
  onStopLocalHost,
  onRefreshBridge,
  onSaveBridgeSettings,
  onRemoveBridgeHost,
  onCopyBridgeText,
  onOpenBridgeConversation,
  onBridgeWizardPrimary,
}: BridgeConfigPageProps) {
  return (
    <>
      <div className="app-bridge-page h-full p-4">
        <div className="app-bridge-main grid gap-3.5 text-white xl:grid-cols-[272px_minmax(0,1fr)]">
          <Card className="app-bridge-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
            <CardHeader>
              <CardTitle className="text-base">My bridge hosts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-300">
              <div className="text-[12px] leading-5 text-slate-400">
                Join existing bridge servers or manage several hosts at once. Kordi will keep discovering people and agents on the active host automatically.
              </div>
              <div className="space-y-2">
                {desktopBridgeState?.hosts.length ? desktopBridgeState.hosts.map((host) => {
                  const active = host.id === activeBridgeHost?.id;
                  return (
                    <button
                      key={host.id}
                      type="button"
                      onClick={() => onSelectBridgeHost(host.id)}
                      className={cn(
                        'app-bridge-list-item w-full rounded-[18px] border px-3 py-2.5 text-left transition',
                        active ? 'border-white/15 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-white">{host.serverUrl}</div>
                          <div className="mt-1 text-[12px] text-slate-400">{host.connected ? 'Connected' : 'Offline'} • {host.visiblePeerCount} visible</div>
                        </div>
                        <div className={cn('mt-0.5 h-2.5 w-2.5 rounded-full', host.connected ? 'bg-emerald-400' : 'bg-slate-500')} />
                      </div>
                    </button>
                  );
                }) : (
                  <div className="app-bridge-empty rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[13px] text-slate-400">
                    <div className="app-bridge-empty-title">No bridge hosts yet</div>
                    <div className="mt-1 text-[12px] leading-5 text-slate-400">Add or join a host to start discovery, messaging, and bridge presence from this desktop.</div>
                  </div>
                )}
              </div>
              <div className="grid gap-1.5">
                <Button variant="secondary" className="justify-start rounded-xl text-[12px]" onClick={() => onOpenBridgeWizard('join')}>
                  <Plus className="mr-2 h-4 w-4" /> Open bridge wizard
                </Button>
                <Button variant="secondary" className="justify-start rounded-xl text-[12px]" onClick={onCreateBridgeDraft}>
                  <Plus className="mr-2 h-4 w-4" /> Add / join host
                </Button>
                <Button variant="secondary" className="justify-start rounded-xl text-[12px]" onClick={onStartLocalHost}>
                  <Globe className="mr-2 h-4 w-4" /> Start local host
                </Button>
                {desktopBridgeState?.localServer.running ? (
                  <Button variant="secondary" className="justify-start rounded-xl text-[12px]" onClick={onStopLocalHost}>
                    <Square className="mr-2 h-4 w-4 fill-current" /> Stop local host
                  </Button>
                ) : null}
                <Button variant="secondary" className="justify-start rounded-xl text-[12px]" onClick={onRefreshBridge}>
                  <Activity className="mr-2 h-4 w-4" /> Refresh discovery
                </Button>
              </div>
              <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[12px] text-slate-400">
                Desktop hosts config: <span className="break-all text-slate-300">{desktopBridgeState?.configPath ?? '~/.korde/desktop-bridges.json'}</span>
              </div>
            </CardContent>
          </Card>
          <div className="space-y-4">
            <Card className="app-bridge-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Bridge host setup</CardTitle>
              </CardHeader>
              <CardContent className="app-bridge-section-content space-y-3.5 text-sm text-slate-300">
                <div className="text-[13px] leading-5 text-slate-400">
                  Add a public or self-hosted server URL, register this desktop node, share the host URL with others, and switch between multiple bridge hosts. Project creation and invites now live on the Projects page.
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
                {bridgeSettingsDraft ? (
                  <>
                    <div>
                      <div className="mb-1.5 text-[12px] font-medium text-white">Server URL</div>
                      <input
                        value={bridgeSettingsDraft.serverUrl}
                        onChange={(event) => setBridgeSettingsDraft((current) => current ? { ...current, serverUrl: event.target.value } : current)}
                        className="app-input-shell app-bridge-field w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                        placeholder="https://your-bridge-server.example.com"
                      />
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button variant="secondary" className="h-7.5 rounded-xl px-3 text-[11px]" onClick={() => setBridgeSettingsDraft((current) => current ? { ...current, serverUrl: desktopBridgeState?.localServer.serverUrl || 'http://127.0.0.1:17080' } : current)}>
                          Localhost preset
                        </Button>
                        <Button variant="secondary" className="h-7.5 rounded-xl px-3 text-[11px]" onClick={() => setBridgeSettingsDraft((current) => current ? { ...current, serverUrl: 'https://your-bridge.example.com' } : current)}>
                          Self-hosted preset
                        </Button>
                        <Button variant="secondary" className="h-7.5 rounded-xl px-3 text-[11px]" onClick={() => setBridgeSettingsDraft((current) => current ? { ...current, serverUrl: 'https://coord.korde.ai' } : current)}>
                          Public host preset
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <div className="mb-1.5 text-[12px] font-medium text-white">Display name</div>
                        <input
                          value={bridgeSettingsDraft.displayName}
                          onChange={(event) => setBridgeSettingsDraft((current) => current ? { ...current, displayName: event.target.value } : current)}
                          className="app-input-shell app-bridge-field w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                          placeholder="Kordi Desktop"
                        />
                      </div>
                      <div>
                        <div className="mb-1.5 text-[12px] font-medium text-white">Owner name</div>
                        <input
                          value={bridgeSettingsDraft.ownerName}
                          onChange={(event) => setBridgeSettingsDraft((current) => current ? { ...current, ownerName: event.target.value } : current)}
                          className="app-input-shell app-bridge-field w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                          placeholder="Your name"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => onOpenBridgeWizard(bridgeSettingsDraft.serverUrl.startsWith('http://127.0.0.1') ? 'self-host' : 'join')}>
                        Wizard
                      </Button>
                      <Button className="rounded-[14px] text-[12px]" onClick={onSaveBridgeSettings} disabled={isDesktopBridgeSaving || !bridgeSettingsDraft.serverUrl.trim()}>
                        {isDesktopBridgeSaving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {bridgeSettingsDraft.hostId ? 'Save host' : 'Join host'}
                      </Button>
                      {bridgeSettingsDraft.hostId ? (
                        <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => onRemoveBridgeHost(bridgeSettingsDraft.hostId!)}>
                          Remove host
                        </Button>
                      ) : null}
                      <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={onRefreshBridge}>
                        Refresh
                      </Button>
                      {activeBridgeHost ? (
                        <>
                          <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => onCopyBridgeText(activeBridgeHost.serverUrl, 'Bridge host URL copied')}>
                            <Copy className="mr-2 h-4 w-4" /> Copy host URL
                          </Button>
                          <Button variant="secondary" className="rounded-[14px]" onClick={() => onCopyBridgeText(`Join my Kordi bridge host:\n${activeBridgeHost.serverUrl}\nNode: ${activeBridgeHost.nodeId ?? 'pending registration'}`, 'Bridge share text copied')}>
                            <Link2 className="mr-2 h-4 w-4" /> Copy share text
                          </Button>
                        </>
                      ) : null}
                    </div>
                    <div className="grid gap-2.5 md:grid-cols-3">
                      <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
                        <div className="mb-1 text-[12px] font-medium text-white">Status</div>
                        <div className="text-[13px] text-slate-300">{activeBridgeHost?.connected ? 'Connected' : 'Not connected'}</div>
                        <div className="mt-1 text-[12px] text-slate-400">{activeBridgeHost?.serverUrl || 'No host selected yet.'}</div>
                      </div>
                      <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
                        <div className="mb-1 text-[12px] font-medium text-white">Local node</div>
                        <div className="text-[13px] text-slate-300 break-all">{activeBridgeHost?.nodeId || 'Not registered yet'}</div>
                        <div className="mt-1 text-[12px] text-slate-400 break-all">{activeBridgeHost?.endpoint || 'No endpoint yet'}</div>
                      </div>
                      <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
                        <div className="mb-1 text-[12px] font-medium text-white">Auto discovery</div>
                        <div className="text-[13px] text-slate-300">{activeBridgeHost?.visiblePeerCount ?? 0} joined</div>
                        <div className="mt-1 text-[12px] text-slate-400">Refreshes while this page stays open.</div>
                      </div>
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>
            <Card className="app-bridge-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Hosting</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-slate-300">
                <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[12px] text-slate-300">
                  <div className="flex items-center justify-between gap-3"><span>Local host</span><span>{desktopBridgeState?.localServer.running ? 'Running' : 'Stopped'}</span></div>
                  <div className="mt-1 break-all text-slate-400">{desktopBridgeState?.localServer.serverUrl || 'http://127.0.0.1:17080'}</div>
                  {desktopBridgeState?.localServer.dbPath ? <div className="mt-1 break-all text-slate-500">DB: {desktopBridgeState.localServer.dbPath}</div> : null}
                </div>
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-[12px] leading-5 text-amber-100">
                  The current Korde codebase is not yet a true one-click full bridge-host deployment on Vercel. The web dashboard can be deployed there, but the persistent coordination backend still needs a real server/database host.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    className="rounded-[14px] text-[12px]"
                    onClick={() => {
                      window.open('https://vercel.com/new/clone?repository-url=https://github.com/Korde-AI/Agent-Bridges&root-directory=web&project-name=korde-bridge-web&repository-name=korde-bridge-web&env=NEXT_PUBLIC_API_URL,NEXT_PUBLIC_COORDINATION_URL,NEXT_PUBLIC_GITEA_URL', '_blank', 'noopener,noreferrer');
                    }}
                  >
                    <ExternalLink className="mr-2 h-4 w-4" /> Deploy dashboard on Vercel
                  </Button>
                  <Button
                    variant="secondary"
                    className="rounded-[14px] text-[12px]"
                    onClick={() => onCopyBridgeText(
                      'Vercel web envs:\nNEXT_PUBLIC_API_URL=https://YOUR-COORDINATION-API\nNEXT_PUBLIC_COORDINATION_URL=https://YOUR-COORDINATION-API\nNEXT_PUBLIC_GITEA_URL=https://YOUR-GITEA-URL',
                      'Vercel env template copied',
                    )}
                  >
                    <Copy className="mr-2 h-4 w-4" /> Copy Vercel env template
                  </Button>
                  <Button
                    variant="secondary"
                    className="rounded-[14px] text-[12px]"
                    onClick={() => onCopyBridgeText(
                      'Self-host guide:\n1. Build Bridges from source\n2. Run: bridges serve --port 17080 --db ./bridges-server.db\n3. Share the public server URL\n4. In Kordi Bridge page, add that URL and join it',
                      'Self-host setup steps copied',
                    )}
                  >
                    <Copy className="mr-2 h-4 w-4" /> Copy self-host steps
                  </Button>
                </div>
                <div className="text-[12px] leading-5 text-slate-400">
                  I wired this so you can keep host management in Bridge itself, but the actual full-server Vercel path still needs a backend refactor away from the current persistent coordination runtime.
                </div>
              </CardContent>
            </Card>
            <div className="grid gap-3.5 lg:grid-cols-2">
              <Card className="app-bridge-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">People on this host</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-slate-300">
                  {activeBridgePeople.length ? activeBridgePeople.map((peer) => (
                    <div key={peer.nodeId} className="app-bridge-list-item rounded-[18px] border border-white/10 bg-white/5 px-3 py-2.5">
                      <div className="text-[13px] font-medium text-white">{peer.displayName || peer.ownerName || peer.nodeId}</div>
                      <div className="mt-1 text-[12px] text-slate-400">{peer.ownerName || 'Unknown owner'} • {peer.runtime}</div>
                      <div className="mt-1 truncate text-[12px] text-slate-500">{peer.endpoint}</div>
                      {peer.sharedProjects.length > 0 ? <div className="mt-1 text-[12px] text-slate-500">Shared projects: {peer.sharedProjects.join(' • ')}</div> : null}
                      {activeBridgeHost ? (
                        <Button variant="secondary" className="mt-2 h-7.5 rounded-xl px-3 text-[11px]" onClick={() => onOpenBridgeConversation(activeBridgeHost.id, peer.nodeId, peer.displayName, peer.ownerName, peer.runtime)}>
                          Message
                        </Button>
                      ) : null}
                    </div>
                  )) : (
                    <div className="app-bridge-empty rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-[13px] text-slate-400">
                      <div className="app-bridge-empty-title">{activeBridgeHost?.registered ? 'No people visible yet' : 'Join a bridge host first'}</div>
                      <div className="mt-1 text-[12px] leading-5 text-slate-400">{activeBridgeHost?.registered ? 'People on this host will appear here once they register and become visible.' : 'Connect this desktop to a bridge host to discover people on the same bridge.'}</div>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card className="app-bridge-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">Agents on this host</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-slate-300">
                  {activeBridgeAgents.length ? activeBridgeAgents.map((peer) => (
                    <div key={peer.nodeId} className="app-bridge-list-item rounded-[18px] border border-white/10 bg-white/5 px-3 py-2.5">
                      <div className="text-[13px] font-medium text-white">{peer.displayName || peer.nodeId}</div>
                      <div className="mt-1 text-[12px] text-slate-400">{peer.ownerName || peer.runtime} • {peer.runtime}</div>
                      <div className="mt-1 truncate text-[12px] text-slate-500">{peer.endpoint}</div>
                      {peer.sharedProjects.length > 0 ? <div className="mt-1 text-[12px] text-slate-500">Shared projects: {peer.sharedProjects.join(' • ')}</div> : null}
                      {activeBridgeHost ? (
                        <Button variant="secondary" className="mt-2 h-7.5 rounded-xl px-3 text-[11px]" onClick={() => onOpenBridgeConversation(activeBridgeHost.id, peer.nodeId, peer.displayName, peer.ownerName, peer.runtime)}>
                          Message
                        </Button>
                      ) : null}
                    </div>
                  )) : (
                    <div className="app-bridge-empty rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-[13px] text-slate-400">
                      <div className="app-bridge-empty-title">{activeBridgeHost?.registered ? 'No agents visible yet' : 'Join a bridge host first'}</div>
                      <div className="mt-1 text-[12px] leading-5 text-slate-400">{activeBridgeHost?.registered ? 'Agents on this host will appear here once they register and become visible.' : 'Connect this desktop to a bridge host to discover agents on the same bridge.'}</div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>

      {bridgeWizardOpen ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 px-6 py-8 backdrop-blur-[10px]" style={{ WebkitAppRegion: 'no-drag' as const }}>
          <div className="app-modal-panel app-bridge-wizard-panel w-full max-w-[620px] rounded-[24px] border border-white/10 p-[18px] text-white shadow-[var(--app-shadow-float)]">
            <div className="mb-3.5 flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Bridge onboarding</div>
                <div className="mt-1 text-[19px] font-semibold">Set up a bridge host</div>
              </div>
              <button type="button" className="app-icon-button rounded-full p-2 text-slate-300 transition hover:text-white" onClick={() => setBridgeWizardOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="app-bridge-wizard-stepper mb-3.5 flex items-center gap-2 text-[11px] text-slate-400">
              {[1, 2, 3].map((step) => (
                <div key={step} className={cn('flex items-center gap-2', step < 3 ? 'flex-1' : '')}>
                  <div className={cn('app-bridge-wizard-step grid h-6 w-6 place-items-center rounded-full border text-[11px]', bridgeWizardStep >= step ? 'border-white/20 bg-white/[0.08] text-white' : 'border-white/10 text-slate-500')}>{step}</div>
                  {step < 3 ? <div className={cn('h-px flex-1', bridgeWizardStep > step ? 'bg-white/20' : 'bg-white/10')} /> : null}
                </div>
              ))}
            </div>
            <div className="space-y-3.5">
              {bridgeWizardStep === 1 ? (
                <>
                  <div className="grid gap-2.5 md:grid-cols-3">
                    {[
                      { id: 'join', label: 'Join an existing host', detail: 'Use a coordination URL you already have.' },
                      { id: 'self-host', label: 'Start my own host', detail: 'Launch a local serve host and register this desktop.' },
                      { id: 'public', label: 'Use a public host', detail: 'Quick-start with a hosted bridge URL.' },
                    ].map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setBridgeWizardDraft((current) => ({
                          ...current,
                          mode: option.id as 'join' | 'self-host' | 'public',
                          serverUrl: option.id === 'self-host'
                            ? (desktopBridgeState?.localServer.serverUrl || 'http://127.0.0.1:17080')
                            : option.id === 'public'
                              ? 'https://coord.korde.ai'
                              : current.serverUrl,
                        }))}
                        className={cn('app-bridge-wizard-option rounded-[18px] border px-3 py-3 text-left transition', bridgeWizardDraft.mode === option.id ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04]')}
                      >
                        <div className="text-[13px] font-medium text-white">{option.label}</div>
                        <div className="mt-1 text-[11px] leading-5 text-slate-400">{option.detail}</div>
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="mb-1.5 text-[12px] font-medium text-white">Server URL</div>
                      <input value={bridgeWizardDraft.serverUrl} onChange={(event) => setBridgeWizardDraft((current) => ({ ...current, serverUrl: event.target.value }))} className="app-input-shell w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none" placeholder="https://your-bridge-server.example.com" />
                    </div>
                    <div>
                      <div className="mb-1.5 text-[12px] font-medium text-white">Display name</div>
                      <input value={bridgeWizardDraft.displayName} onChange={(event) => setBridgeWizardDraft((current) => ({ ...current, displayName: event.target.value }))} className="app-input-shell w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none" placeholder="Kordi Desktop" />
                    </div>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[12px] font-medium text-white">Owner name</div>
                    <input value={bridgeWizardDraft.ownerName} onChange={(event) => setBridgeWizardDraft((current) => ({ ...current, ownerName: event.target.value }))} className="app-input-shell w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none" placeholder="Your name" />
                  </div>
                </>
              ) : null}
              {bridgeWizardStep === 2 ? (
                <div className="space-y-3">
                  <div className="text-[12px] leading-5 text-slate-400">Host connected. This page stays focused on setup and discovery only.</div>
                  <div className="grid gap-2.5 md:grid-cols-3">
                    <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[12px] text-slate-300">
                      <div className="font-medium text-white">Host</div>
                      <div className="mt-1 break-all text-slate-400">{activeBridgeHost?.serverUrl || bridgeWizardDraft.serverUrl || 'Not connected yet'}</div>
                    </div>
                    <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[12px] text-slate-300">
                      <div className="font-medium text-white">Node</div>
                      <div className="mt-1 break-all text-slate-400">{activeBridgeHost?.nodeId || 'Pending registration'}</div>
                    </div>
                    <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[12px] text-slate-300">
                      <div className="font-medium text-white">Discovery</div>
                      <div className="mt-1 text-slate-400">{activeBridgeHost?.visiblePeerCount ?? 0} visible on this bridge</div>
                    </div>
                  </div>
                </div>
              ) : null}
              {bridgeWizardStep === 3 ? (
                <div className="space-y-3">
                  <div className="app-bridge-meta-block rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-[12px] text-emerald-100">
                    Bridge setup is complete.
                  </div>
                  <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[12px] leading-5 text-slate-300">
                    Create bridge projects and invites from <span className="font-medium text-white">Projects</span>. <span className="font-medium text-white">Bridge</span> only manages hosts and shows people or agents on the same bridge.
                  </div>
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button variant="secondary" className="rounded-[14px]" onClick={() => {
                if (bridgeWizardStep === 1) {
                  setBridgeWizardOpen(false);
                } else {
                  setBridgeWizardStep((current) => Math.max(1, current - 1) as 1 | 2 | 3);
                }
              }}>
                Back
              </Button>
              <Button className="rounded-[14px]" onClick={onBridgeWizardPrimary}>
                {bridgeWizardStep === 3 ? 'Done' : 'Continue'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
