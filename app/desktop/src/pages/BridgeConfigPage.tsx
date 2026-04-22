import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  Bot,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Link2,
  LoaderCircle,
  Plus,
  Star,
  Upload,
  UserRound,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { openDesktopExternalUrl } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import type { DesktopBridgeHost, DesktopBridgePeer, DesktopBridgeState } from '@/kordi-app/types';

type DiscoveryMode = 'off' | 'contacts' | 'open';
type BridgeStepId = 'setup' | 'identity' | 'agents' | 'discover';
type BridgePageSection = 'servers' | 'details' | 'advanced';

type BridgeSettingsDraft = {
  hostId?: string | null;
  serverUrl: string;
  displayName: string;
  ownerName: string;
};

type BridgeWizardDraft = {
  mode: 'have-url' | 'need-host';
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
  onCreateBridgeDraft: () => void;
  onRefreshBridge: () => Promise<void> | void;
  onSaveBridgeSettings: (draftOverride?: { hostId?: string | null; serverUrl: string; displayName: string; ownerName: string }) => void;
  onRemoveBridgeHost: (hostId: string) => Promise<void>;
  onCopyBridgeText: (value: string, successMessage?: string) => void;
  onOpenBridgeConfigFolder: () => Promise<void>;
  onRevealBridgeStorageFile: (kind: 'config' | 'conversations' | 'legacy') => Promise<void>;
  onExportBridgeHostsConfig: () => Promise<void>;
  onImportBridgeHostsConfig: (raw: string) => Promise<void>;
  onAddBridgeContact: (hostId: string, peerNodeId: string) => Promise<void>;
  onSetBridgeDiscoveryMode: (hostId: string, discoveryMode: DiscoveryMode) => Promise<void>;
  onCreateBridgeAgent: (hostId: string, label?: string) => Promise<void>;
  onActivateBridgeAgent: (hostId: string, agentId: string) => Promise<void>;
  onSetDefaultBridgeAgent: (hostId: string, agentId: string) => Promise<void>;
  onRemoveBridgeContact: (hostId: string, peerNodeId: string) => Promise<void>;
  onOpenBridgeConversation: (
    hostId: string,
    peerNodeId: string,
    peerDisplayName?: string | null,
    peerOwnerName?: string | null,
    peerRuntime?: string | null,
  ) => void;
  onBridgeWizardPrimary: () => void;
};

const DISCOVERY_OPTIONS: Array<{ value: DiscoveryMode; label: string; detail: string }> = [
  { value: 'off', label: 'Off', detail: 'Do not appear in open host discovery.' },
  { value: 'contacts', label: 'Contacts only', detail: 'Only contacts and shared projects can see you.' },
  { value: 'open', label: 'Open on this host', detail: 'Let people on this host discover you.' },
];

function discoveryLabel(value?: string | null) {
  switch ((value ?? '').toLowerCase()) {
    case 'off':
      return 'Off';
    case 'contacts':
      return 'Contacts only';
    case 'open':
      return 'Open on this host';
    default:
      return 'Open on this host';
  }
}

function SectionNav({
  activeSection,
  setActiveSection,
  activeBridgeHost,
}: {
  activeSection: BridgePageSection;
  setActiveSection: Dispatch<SetStateAction<BridgePageSection>>;
  activeBridgeHost: DesktopBridgeHost | null;
}) {
  const sections: Array<{ id: BridgePageSection; title: string; detail: string; disabled?: boolean }> = [
    { id: 'servers', title: 'Servers', detail: 'Configured bridge hosts and add/join flow.' },
    { id: 'details', title: 'Server details', detail: 'Identity, discovery, and active bridge agents.', disabled: !activeBridgeHost },
    { id: 'advanced', title: 'Advanced', detail: 'Local files, Finder tools, export, and import.' },
  ];

  return (
    <div className="app-bridge-section-nav grid gap-2 lg:grid-cols-3">
      {sections.map((section) => {
        const active = section.id === activeSection;
        return (
          <button
            key={section.id}
            type="button"
            disabled={section.disabled}
            onClick={() => setActiveSection(section.id)}
            className={cn(
              'rounded-[18px] border px-3 py-3 text-left transition',
              active ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
              section.disabled ? 'cursor-not-allowed opacity-45 hover:bg-white/[0.04]' : '',
            )}
          >
            <div className="text-[12px] font-medium text-white">{section.title}</div>
            <div className="mt-1 text-[11px] leading-5 text-slate-400">{section.detail}</div>
          </button>
        );
      })}
    </div>
  );
}

function DetailNav({
  activeStep,
  setActiveStep,
  activeBridgeHost,
}: {
  activeStep: BridgeStepId;
  setActiveStep: Dispatch<SetStateAction<BridgeStepId>>;
  activeBridgeHost: DesktopBridgeHost | null;
}) {
  const steps: Array<{ id: Exclude<BridgeStepId, 'setup'>; title: string; detail: string; disabled?: boolean }> = [
    { id: 'identity', title: 'Identity', detail: 'Your bridge name and visibility.' },
    { id: 'agents', title: 'Agents', detail: 'Active and default bridge agents.' },
    { id: 'discover', title: 'Discover', detail: 'People, agents, and direct contact.', disabled: !activeBridgeHost?.registered },
  ];

  return (
    <div className="app-bridge-detail-nav grid gap-2 lg:grid-cols-3">
      {steps.map((step) => {
        const active = step.id === activeStep || (activeStep === 'setup' && step.id === 'identity');
        return (
          <button
            key={step.id}
            type="button"
            disabled={step.disabled}
            onClick={() => setActiveStep(step.id)}
            className={cn(
              'rounded-[16px] border px-3 py-2.5 text-left transition',
              active ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
              step.disabled ? 'cursor-not-allowed opacity-45 hover:bg-white/[0.04]' : '',
            )}
          >
            <div className="text-[12px] font-medium text-white">{step.title}</div>
            <div className="mt-1 text-[11px] leading-5 text-slate-400">{step.detail}</div>
          </button>
        );
      })}
    </div>
  );
}

function DiscoveryModeSelector({
  activeBridgeHost,
  onSetBridgeDiscoveryMode,
}: {
  activeBridgeHost: DesktopBridgeHost;
  onSetBridgeDiscoveryMode: BridgeConfigPageProps['onSetBridgeDiscoveryMode'];
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
        {DISCOVERY_OPTIONS.map((option) => {
          const active = activeBridgeHost.discoveryMode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                void onSetBridgeDiscoveryMode(activeBridgeHost.id, option.value).catch(() => {});
              }}
              className={cn(
                'rounded-[16px] border px-3 py-2.5 text-left transition',
                active ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
              )}
            >
              <div className="text-[12px] font-medium text-white">{option.label}</div>
              <div className="mt-1 text-[11px] leading-5 text-slate-400">{option.detail}</div>
            </button>
          );
        })}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="app-bridge-empty rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[13px] text-slate-400">
      <div className="app-bridge-empty-title">{title}</div>
      <div className="mt-1 text-[12px] leading-5 text-slate-400">{detail}</div>
    </div>
  );
}

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
  onCreateBridgeDraft,
  onRefreshBridge,
  onSaveBridgeSettings,
  onRemoveBridgeHost,
  onCopyBridgeText,
  onOpenBridgeConfigFolder,
  onRevealBridgeStorageFile,
  onExportBridgeHostsConfig,
  onImportBridgeHostsConfig,
  onAddBridgeContact,
  onSetBridgeDiscoveryMode,
  onCreateBridgeAgent,
  onActivateBridgeAgent,
  onSetDefaultBridgeAgent,
  onRemoveBridgeContact,
  onOpenBridgeConversation,
  onBridgeWizardPrimary,
}: BridgeConfigPageProps) {
  const [activeSection, setActiveSection] = useState<BridgePageSection>('servers');
  const [activeStep, setActiveStep] = useState<BridgeStepId>('identity');
  const importBridgeConfigInputRef = useRef<HTMLInputElement | null>(null);
  const [setupMode, setSetupMode] = useState<'have-url' | 'need-host'>('have-url');
  const [showSetupComposer, setShowSetupComposer] = useState(false);
  const [pendingRemoveHost, setPendingRemoveHost] = useState<DesktopBridgeHost | null>(null);
  const [isRemovingHost, setIsRemovingHost] = useState(false);
  const [contactNodeId, setContactNodeId] = useState('');
  const [identityOwnerName, setIdentityOwnerName] = useState('');

  const activeDefaultAgent = useMemo(
    () => activeBridgeHost?.agents.find((agent) => agent.isDefault) ?? activeBridgeHost?.agents[0] ?? null,
    [activeBridgeHost],
  );

  useEffect(() => {
    if (!activeBridgeHost && activeSection === 'details') {
      setActiveSection('servers');
    }
    if (activeStep === 'discover' && !activeBridgeHost?.registered) {
      setActiveStep('identity');
    }
  }, [activeBridgeHost, activeSection, activeStep]);

  useEffect(() => {
    if (showSetupComposer && bridgeSettingsDraft?.hostId) {
      setShowSetupComposer(false);
      setActiveSection('details');
    }
  }, [bridgeSettingsDraft?.hostId, showSetupComposer]);

  useEffect(() => {
    setIdentityOwnerName(activeBridgeHost?.ownerName ?? bridgeSettingsDraft?.ownerName ?? 'Kordi User');
  }, [activeBridgeHost?.ownerName, bridgeSettingsDraft?.ownerName]);

  const closeSetupComposer = () => {
    setShowSetupComposer(false);
    setSetupMode('have-url');
  };

  useEffect(() => {
    if (activeSection !== 'servers' && showSetupComposer) {
      closeSetupComposer();
    }
  }, [activeSection, showSetupComposer]);

  const renderSetupStorageInfo = () => {
    if (!desktopBridgeState) return null;

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
            <div className="app-bridge-meta-block app-bridge-inspector-row rounded-[16px] px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Bridge hosts config</div>
                  <div className="mt-1 break-all text-[12px] text-slate-300">{desktopBridgeState.configPath}</div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="secondary" className="rounded-[12px] px-3 text-[11px]" onClick={() => void onRevealBridgeStorageFile('config')}>
                    <FolderOpen className="mr-2 h-3.5 w-3.5" /> Reveal file in Finder
                  </Button>
                  <Button variant="secondary" className="rounded-[12px] px-3 text-[11px]" onClick={() => onCopyBridgeText(desktopBridgeState.configPath, 'Bridge config path copied')}>
                    <Copy className="mr-2 h-3.5 w-3.5" /> Copy path
                  </Button>
                </div>
              </div>
            </div>
            <div className="app-bridge-meta-block app-bridge-inspector-row rounded-[16px] px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Bridge conversations</div>
                  <div className="mt-1 break-all text-[12px] text-slate-300">{desktopBridgeState.conversationsPath}</div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="secondary" className="rounded-[12px] px-3 text-[11px]" onClick={() => void onRevealBridgeStorageFile('conversations')}>
                    <FolderOpen className="mr-2 h-3.5 w-3.5" /> Reveal file in Finder
                  </Button>
                  <Button variant="secondary" className="rounded-[12px] px-3 text-[11px]" onClick={() => onCopyBridgeText(desktopBridgeState.conversationsPath, 'Bridge conversations path copied')}>
                    <Copy className="mr-2 h-3.5 w-3.5" /> Copy path
                  </Button>
                </div>
              </div>
            </div>
            <div className="app-bridge-meta-block app-bridge-inspector-row rounded-[16px] px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Legacy bridge config</div>
                  <div className="mt-1 break-all text-[12px] text-slate-300">{desktopBridgeState.legacyConfigPath}</div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="secondary" className="rounded-[12px] px-3 text-[11px]" onClick={() => void onRevealBridgeStorageFile('legacy')}>
                    <FolderOpen className="mr-2 h-3.5 w-3.5" /> Reveal file in Finder
                  </Button>
                  <Button variant="secondary" className="rounded-[12px] px-3 text-[11px]" onClick={() => onCopyBridgeText(desktopBridgeState.legacyConfigPath, 'Legacy bridge config path copied')}>
                    <Copy className="mr-2 h-3.5 w-3.5" /> Copy path
                  </Button>
                </div>
              </div>
            </div>
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
  };

  const renderSetupStep = () => {
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
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setSetupMode('have-url')}
              className={cn(
                'rounded-[18px] border px-3 py-3 text-left transition',
                setupMode === 'have-url' ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
              )}
            >
              <div className="text-[12px] font-medium text-white">I have a bridge host URL</div>
              <div className="mt-1 text-[11px] leading-5 text-slate-400">Paste the hosted service URL and connect this desktop to it.</div>
            </button>
            <button
              type="button"
              onClick={() => setSetupMode('need-host')}
              className={cn(
                'rounded-[18px] border px-3 py-3 text-left transition',
                setupMode === 'need-host' ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
              )}
            >
              <div className="text-[12px] font-medium text-white">I need to start a new host</div>
              <div className="mt-1 text-[11px] leading-5 text-slate-400">Use the Kordi guide to host the server, then come back with the final hosted URL.</div>
            </button>
          </div>
          {bridgeSettingsDraft ? setupMode === 'have-url' ? (
            <>
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-white">Bridge host URL</div>
                <input
                  value={bridgeSettingsDraft.serverUrl}
                  onChange={(event) => setBridgeSettingsDraft((current) => current ? { ...current, serverUrl: event.target.value } : current)}
                  className="app-input-shell app-bridge-field w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                  placeholder="https://your-bridge-server.example.com"
                />
                <div className="mt-2 text-[11px] leading-5 text-slate-500">
                  Use the final public hosted URL here. Remote bridge hosts should use <span className="text-slate-300">https://</span>.
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-white">Your name</div>
                <input
                  value={bridgeSettingsDraft.ownerName}
                  onChange={(event) => setBridgeSettingsDraft((current) => current ? { ...current, ownerName: event.target.value } : current)}
                  className="app-input-shell app-bridge-field w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                  placeholder="Your name"
                />
                <div className="mt-2 text-[11px] leading-5 text-slate-500">
                  Your primary agent name is managed from the <span className="text-slate-300">Agents</span> page.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button className="rounded-[14px] text-[12px]" onClick={() => onSaveBridgeSettings()} disabled={isDesktopBridgeSaving || !bridgeSettingsDraft.serverUrl.trim()}>
                  {isDesktopBridgeSaving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {bridgeSettingsDraft.hostId ? 'Save host' : 'Join host'}
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-[12px] leading-5 text-amber-100">
                Bridges is for real collaboration, so you need a hosted bridge server URL that your teammates can actually reach.
              </div>
              <div className="text-[12px] leading-5 text-slate-400">
                The Kordi server setup guide walks through running Bridges from this Kordi repo on your own VM, cloud machine, or always-on lab machine. Kordi Desktop already bundles the local bridge tooling, so teammates only need the final hosted URL here.
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  className="rounded-[14px] text-[12px]"
                  onClick={() => {
                    void openDesktopExternalUrl('https://github.com/Kordi-AI/Kordi/blob/main/bridges/docs/self-host-guide.md');
                  }}
                >
                  <ExternalLink className="mr-2 h-4 w-4" /> Open server setup guide
                </Button>
                <Button
                  variant="secondary"
                  className="rounded-[14px] text-[12px]"
                  onClick={() => {
                    void openDesktopExternalUrl('https://github.com/Kordi-AI/Kordi/tree/main/bridges');
                  }}
                >
                  Open Kordi Bridges source
                </Button>
              </div>
            </div>
          ) : null}
          </CardContent>
        </Card>
      </div>
    );
  };

  const renderIdentityStep = () => {
    if (!activeBridgeHost) {
      return <EmptyState title="Connect a host first" detail="Finish step 1 before checking your identity." />;
    }

    const trimmedIdentityOwnerName = identityOwnerName.trim();
    const identityNameChanged = trimmedIdentityOwnerName.length > 0 && trimmedIdentityOwnerName !== activeBridgeHost.ownerName.trim();

    return (
      <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
        <CardHeader>
          <CardTitle className="text-base">My identity on this host</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-slate-300">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
              <div className="mb-1 text-[12px] font-medium text-white">Human</div>
              <div className="text-[13px] text-slate-200">{activeBridgeHost.ownerName}</div>
              <div className="mt-1 break-all text-[12px] text-slate-500">Human ID: {activeBridgeHost.humanId}</div>
            </div>
            <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
              <div className="mb-1 text-[12px] font-medium text-white">Default agent</div>
              <div className="text-[13px] text-slate-200">{activeDefaultAgent?.label || activeBridgeHost.displayName}</div>
              <div className="mt-1 break-all text-[12px] text-slate-500">Agent ID: {activeDefaultAgent?.id || 'pending'}</div>
            </div>
            <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
              <div className="mb-1 text-[12px] font-medium text-white">Current node</div>
              <div className="text-[13px] text-slate-200">{activeBridgeHost.connected ? 'Connected' : 'Offline'}</div>
              <div className="mt-1 break-all text-[12px] text-slate-500">Node ID: {activeBridgeHost.nodeId || 'pending registration'}</div>
            </div>
          </div>

          <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
            <div className="mb-2 text-[12px] font-medium text-white">Your name on this host</div>
            <input
              value={identityOwnerName}
              onChange={(event) => setIdentityOwnerName(event.target.value)}
              className="app-input-shell app-bridge-field w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
              placeholder="Your name"
            />
            <div className="mt-2 text-[11px] leading-5 text-slate-500">
              Agent names are managed from the <span className="text-slate-300">Agents</span> page.
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                className="rounded-[14px] text-[12px]"
                disabled={isDesktopBridgeSaving || !identityNameChanged}
                onClick={() => {
                  setBridgeSettingsDraft((current) => current ? {
                    ...current,
                    ownerName: trimmedIdentityOwnerName,
                  } : current);
                  onSaveBridgeSettings({
                    hostId: bridgeSettingsDraft?.hostId ?? activeBridgeHost.id,
                    serverUrl: bridgeSettingsDraft?.serverUrl || activeBridgeHost.serverUrl,
                    displayName: bridgeSettingsDraft?.displayName || activeBridgeHost.displayName || 'Kordi',
                    ownerName: trimmedIdentityOwnerName,
                  });
                }}
              >
                {isDesktopBridgeSaving ? 'Saving…' : 'Save name'}
              </Button>
            </div>
          </div>

          <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
            <div className="mb-2 text-[12px] font-medium text-white">How visible should I be?</div>
            <DiscoveryModeSelector activeBridgeHost={activeBridgeHost} onSetBridgeDiscoveryMode={onSetBridgeDiscoveryMode} />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => onCopyBridgeText(activeBridgeHost.serverUrl, 'Bridge host URL copied')}>
              <Copy className="mr-2 h-4 w-4" /> Copy host URL
            </Button>
            <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => onCopyBridgeText(`Join my Kordi bridge host:\n${activeBridgeHost.serverUrl}\nHuman ID: ${activeBridgeHost.humanId}\nDefault agent ID: ${activeDefaultAgent?.id ?? 'pending agent'}\nNode: ${activeBridgeHost.nodeId ?? 'pending registration'}`, 'Bridge share text copied')}>
              <Link2 className="mr-2 h-4 w-4" /> Copy share text
            </Button>
            <Button className="rounded-[14px] text-[12px]" onClick={() => setActiveStep('agents')}>
              Next: My agents <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderAgentsStep = () => {
    if (!activeBridgeHost) {
      return <EmptyState title="Connect a host first" detail="Finish step 1 before choosing agents." />;
    }

    return (
      <div className="w-full space-y-4">
        <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">My agents</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3.5 text-sm text-slate-300">
            <div className="text-[12px] leading-5 text-slate-400">
              Bridge decides which agent is active and which one is the default identity for this host. Agent naming belongs in the <span className="text-slate-200">Agents</span> page.
            </div>
            <div className="space-y-2">
              {activeBridgeHost.agents.map((agent) => (
                <div key={agent.id} className="app-bridge-list-item rounded-[18px] border border-white/10 bg-white/[0.04] px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[13px] font-medium text-white">{agent.label}</div>
                        {agent.isActive ? <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-1 text-[11px] leading-none text-cyan-100">Active</span> : null}
                        {agent.isDefault ? <span className="rounded-full border border-white/12 bg-white/[0.05] px-2 py-1 text-[11px] leading-none text-slate-200">Default</span> : null}
                        <span className={cn('rounded-full border px-2 py-1 text-[11px] leading-none', agent.registered ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100' : 'border-amber-400/20 bg-amber-400/10 text-amber-100')}>
                          {agent.registered ? 'Registered' : 'Local only'}
                        </span>
                      </div>
                      <div className="mt-1 text-[12px] text-slate-400">{agent.runtime}</div>
                      <div className="mt-1 break-all text-[12px] text-slate-500">Agent ID: {agent.id}</div>
                      <div className="mt-1 break-all text-[12px] text-slate-500">Node ID: {agent.nodeId || 'pending registration'}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {!agent.isActive ? (
                          <Button variant="secondary" className="h-7.5 rounded-xl px-3 text-[11px]" onClick={() => { void onActivateBridgeAgent(activeBridgeHost.id, agent.id).catch(() => {}); }}>
                            Use this agent
                          </Button>
                        ) : null}
                        {!agent.isDefault ? (
                          <Button variant="secondary" className="h-7.5 rounded-xl px-3 text-[11px]" onClick={() => { void onSetDefaultBridgeAgent(activeBridgeHost.id, agent.id).catch(() => {}); }}>
                            <Star className="mr-1.5 h-3.5 w-3.5" /> Set default
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Create another agent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-300">
            <div className="text-[12px] leading-5 text-slate-400">
              Create a new bridge agent identity under this same human profile. You can rename it later from the <span className="text-slate-200">Agents</span> page.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="rounded-[14px] text-[12px]"
                onClick={() => {
                  void onCreateBridgeAgent(activeBridgeHost.id)
                    .catch(() => {});
                }}
              >
                <Plus className="mr-2 h-4 w-4" /> Add agent
              </Button>
            </div>
            <div className="flex justify-end">
              <Button className="rounded-[14px] text-[12px]" onClick={() => setActiveStep('discover')} disabled={!activeBridgeHost.registered}>
                Next: Discover <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  };

  const renderPeerCard = (peer: DesktopBridgePeer, kind: 'person' | 'agent') => (
    <div key={peer.nodeId} className="app-bridge-list-item rounded-[18px] border border-white/10 bg-white/5 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-slate-200">
          {kind === 'person' ? <UserRound className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[13px] font-medium text-white">{peer.displayName || peer.ownerName || peer.nodeId}</div>
            {kind === 'agent' && peer.isDefaultAgent ? <span className="rounded-full border border-white/12 bg-white/[0.05] px-2 py-1 text-[11px] leading-none text-slate-200">Default</span> : null}
          </div>
          <div className="mt-1 text-[12px] text-slate-400">{peer.ownerName || peer.runtime} • {peer.runtime}</div>
          {peer.humanId ? <div className="mt-1 break-all text-[12px] text-slate-500">Human ID: {peer.humanId}</div> : null}
          {peer.agentId ? <div className="mt-1 break-all text-[12px] text-slate-500">Agent ID: {peer.agentId}</div> : null}
          {peer.sharedProjects.length > 0 ? <div className="mt-1 text-[12px] text-slate-500">Shared projects: {peer.sharedProjects.join(' • ')}</div> : null}
          {activeBridgeHost ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="secondary" className="h-7.5 rounded-xl px-3 text-[11px]" onClick={() => onOpenBridgeConversation(activeBridgeHost.id, peer.nodeId, peer.displayName, peer.ownerName, peer.runtime)}>
                Message
              </Button>
              <Button variant="secondary" className="h-7.5 rounded-xl px-3 text-[11px]" onClick={() => { void onRemoveBridgeContact(activeBridgeHost.id, peer.nodeId).catch(() => {}); }}>
                Remove contact
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  const renderDiscoverStep = () => {
    if (!activeBridgeHost?.registered) {
      return <EmptyState title="Finish setup first" detail="Once your current host is registered, discovery and direct chat will appear here." />;
    }

    return (
      <div className="w-full space-y-4">
        <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Direct contact by node ID</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-300">
            <div className="text-[12px] leading-5 text-slate-400">Know someone’s node ID already? Add them directly, then open a chat immediately.</div>
            <div className="flex flex-col gap-2 md:flex-row">
              <input
                value={contactNodeId}
                onChange={(event) => setContactNodeId(event.target.value)}
                className="app-input-shell app-bridge-field min-w-0 flex-1 rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                placeholder="kd_..."
              />
              <Button
                variant="secondary"
                className="rounded-[14px] text-[12px]"
                disabled={!contactNodeId.trim()}
                onClick={() => {
                  const trimmedNodeId = contactNodeId.trim();
                  if (!trimmedNodeId) return;
                  void onAddBridgeContact(activeBridgeHost.id, trimmedNodeId)
                    .then(() => setContactNodeId(''))
                    .catch(() => {});
                }}
              >
                Add contact
              </Button>
              <Button
                className="rounded-[14px] text-[12px]"
                disabled={!contactNodeId.trim()}
                onClick={() => {
                  const trimmedNodeId = contactNodeId.trim();
                  if (!trimmedNodeId) return;
                  void onAddBridgeContact(activeBridgeHost.id, trimmedNodeId)
                    .then(() => {
                      setContactNodeId('');
                      onOpenBridgeConversation(activeBridgeHost.id, trimmedNodeId);
                    })
                    .catch(() => {});
                }}
              >
                Add + chat
              </Button>
            </div>
            <div className="app-bridge-meta-block rounded-[18px] px-3 py-3 text-[12px] leading-5 text-slate-400">
              Current visibility: <span className="text-slate-200">{discoveryLabel(activeBridgeHost.discoveryMode)}</span>. Contacts and shared projects still work even when open discovery is off.
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3.5 lg:grid-cols-2">
          <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
            <CardHeader>
              <CardTitle className="text-base">People on this host</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-300">
              {activeBridgePeople.length
                ? activeBridgePeople.map((peer) => renderPeerCard(peer, 'person'))
                : <EmptyState title="No people visible yet" detail="People appear here from contacts, shared projects, or open same-host discovery." />}
            </CardContent>
          </Card>

          <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Agents on this host</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-300">
              {activeBridgeAgents.length
                ? activeBridgeAgents.map((peer) => renderPeerCard(peer, 'agent'))
                : <EmptyState title="No agents visible yet" detail="Agents appear here from contacts, shared projects, or open same-host discovery." />}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  };

  const renderDetailsSection = () => {
    if (!activeBridgeHost) {
      return <EmptyState title="Select a bridge server first" detail="Choose a configured server to manage identity, discovery, and bridge agents." />;
    }

    return (
      <div className="w-full space-y-4">
        <Card className="app-bridge-card app-bridge-overview-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">Server details</CardTitle>
                <div className="mt-1 break-all text-[12px] leading-5 text-slate-400">{activeBridgeHost.serverUrl}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => setActiveSection('servers')}>
                  Back to servers
                </Button>
                <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => setActiveSection('advanced')}>
                  Advanced
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-slate-300">
            <div className="app-bridge-overview-grid grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
                <div className="mb-1 text-[12px] font-medium text-white">Connection</div>
                <div className="text-[13px] text-slate-200">{activeBridgeHost.connected ? 'Connected' : 'Offline'}</div>
                <div className="mt-1 text-[12px] text-slate-500">{activeBridgeHost.visiblePeerCount} visible on this host</div>
              </div>
              <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
                <div className="mb-1 text-[12px] font-medium text-white">Your name</div>
                <div className="text-[13px] text-slate-200">{activeBridgeHost.ownerName}</div>
                <div className="mt-1 break-all text-[12px] text-slate-500">Human ID: {activeBridgeHost.humanId}</div>
              </div>
              <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
                <div className="mb-1 text-[12px] font-medium text-white">Primary agent</div>
                <div className="text-[13px] text-slate-200">{activeDefaultAgent?.label || activeBridgeHost.displayName}</div>
                <div className="mt-1 break-all text-[12px] text-slate-500">Agent ID: {activeDefaultAgent?.id || 'pending'}</div>
              </div>
              <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
                <div className="mb-1 text-[12px] font-medium text-white">Discovery</div>
                <div className="text-[13px] text-slate-200">{discoveryLabel(activeBridgeHost.discoveryMode)}</div>
                <div className="mt-1 break-all text-[12px] text-slate-500">Node ID: {activeBridgeHost.nodeId || 'pending registration'}</div>
              </div>
            </div>
            <div className="app-bridge-toolbar flex flex-wrap gap-2">
              <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => onCopyBridgeText(activeBridgeHost.serverUrl, 'Bridge host URL copied')}>
                <Copy className="mr-2 h-4 w-4" /> Copy host URL
              </Button>
              <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => onCopyBridgeText(`Join my Kordi bridge host:\n${activeBridgeHost.serverUrl}\nHuman ID: ${activeBridgeHost.humanId}\nDefault agent ID: ${activeDefaultAgent?.id ?? 'pending agent'}\nNode: ${activeBridgeHost.nodeId ?? 'pending registration'}`, 'Bridge share text copied')}>
                <Link2 className="mr-2 h-4 w-4" /> Copy share text
              </Button>
              <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => setActiveStep('discover')} disabled={!activeBridgeHost.registered}>
                Open discover
              </Button>
            </div>
            <DetailNav activeStep={activeStep} setActiveStep={setActiveStep} activeBridgeHost={activeBridgeHost} />
          </CardContent>
        </Card>

        {activeStep === 'agents' ? renderAgentsStep() : null}
        {activeStep === 'discover' ? renderDiscoverStep() : null}
        {activeStep === 'identity' || activeStep === 'setup' ? renderIdentityStep() : null}
      </div>
    );
  };

  const renderAdvancedSection = () => (
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
      {renderSetupStorageInfo()}
    </div>
  );

  return (
    <>
      <div className="app-bridge-page app-scroll-area flex h-full min-w-0 flex-1 justify-center overflow-y-auto p-4">
        <div className="app-bridge-main app-bridge-shell w-full space-y-4 text-white">
          <Card className="app-bridge-card app-bridge-nav-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
            <CardHeader>
              <div className="space-y-3">
                <div>
                  <CardTitle className="text-base">Bridge</CardTitle>
                  <div className="mt-1 text-[12px] leading-5 text-slate-400">
                    Manage bridge servers first, then drill into the currently selected server only when you need identity, discovery, or advanced local file tools.
                  </div>
                </div>
                <SectionNav activeSection={activeSection} setActiveSection={setActiveSection} activeBridgeHost={activeBridgeHost} />
              </div>
            </CardHeader>
          </Card>

          <div className="app-bridge-page-stack space-y-4">
            {activeSection === 'servers' ? renderSetupStep() : null}
            {activeSection === 'details' ? renderDetailsSection() : null}
            {activeSection === 'advanced' ? renderAdvancedSection() : null}
          </div>
        </div>
      </div>

      {pendingRemoveHost ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 px-6 py-8 backdrop-blur-[10px]" style={{ WebkitAppRegion: 'no-drag' as const }}>
          <div className="app-modal-panel w-full max-w-[420px] rounded-[24px] border border-white/10 p-[18px] text-white shadow-[var(--app-shadow-float)]">
            <div className="mb-3">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Remove bridge server</div>
              <div className="mt-1 text-[18px] font-semibold">Are you sure?</div>
              <div className="mt-2 break-all text-[12px] leading-5 text-slate-400">
                {pendingRemoveHost.serverUrl}
              </div>
            </div>
            <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2.5 text-[12px] leading-5 text-rose-100">
              This removes the bridge host from this desktop and clears its local bridge conversations.
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="secondary" type="button" className="rounded-[14px]" style={{ WebkitAppRegion: 'no-drag' as const }} onClick={() => setPendingRemoveHost(null)} disabled={isRemovingHost}>
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
      ) : null}

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
                  <div className="grid gap-2.5 md:grid-cols-2">
                    {[
                      { id: 'have-url', label: 'I have a bridge host URL', detail: 'Paste the hosted service URL and connect this desktop.' },
                      { id: 'need-host', label: 'I need to start a new host', detail: 'Use the Kordi guide to host a server, then come back with the final hosted URL.' },
                    ].map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setBridgeWizardDraft((current) => ({
                          ...current,
                          mode: option.id as 'have-url' | 'need-host',
                        }))}
                        className={cn('app-bridge-wizard-option rounded-[18px] border px-3 py-3 text-left transition', bridgeWizardDraft.mode === option.id ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04]')}
                      >
                        <div className="text-[13px] font-medium text-white">{option.label}</div>
                        <div className="mt-1 text-[11px] leading-5 text-slate-400">{option.detail}</div>
                      </button>
                    ))}
                  </div>
                  {bridgeWizardDraft.mode === 'have-url' ? (
                    <>
                      <div>
                        <div className="mb-1.5 text-[12px] font-medium text-white">Bridge host URL</div>
                        <input value={bridgeWizardDraft.serverUrl} onChange={(event) => setBridgeWizardDraft((current) => ({ ...current, serverUrl: event.target.value }))} className="app-input-shell w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none" placeholder="https://your-bridge-server.example.com" />
                        <div className="mt-2 text-[11px] leading-5 text-slate-500">Use the final public hosted URL here. Remote bridge hosts should use <span className="text-slate-300">https://</span>.</div>
                      </div>
                      <div>
                        <div className="mb-1.5 text-[12px] font-medium text-white">Your name</div>
                        <input value={bridgeWizardDraft.ownerName} onChange={(event) => setBridgeWizardDraft((current) => ({ ...current, ownerName: event.target.value }))} className="app-input-shell w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none" placeholder="Your name" />
                        <div className="mt-2 text-[11px] leading-5 text-slate-500">Primary agent naming is managed later from the <span className="text-slate-300">Agents</span> page.</div>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-3">
                      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-[12px] leading-5 text-amber-100">
                        You need a hosted bridge service URL before this desktop can join a collaboration host.
                      </div>
                      <div className="text-[12px] leading-5 text-slate-400">
                        Start with the Kordi server setup guide if you want to configure the server stack yourself. Kordi Desktop already bundles the local bridge tooling, so after the server exists you only come back here with the final hosted URL.
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          className="rounded-[14px] text-[12px]"
                          onClick={() => {
                            void openDesktopExternalUrl('https://github.com/Kordi-AI/Kordi/blob/main/bridges/docs/self-host-guide.md');
                          }}
                        >
                          <ExternalLink className="mr-2 h-4 w-4" /> Open server setup guide
                        </Button>
                        <Button
                          variant="secondary"
                          className="rounded-[14px] text-[12px]"
                          onClick={() => {
                            void openDesktopExternalUrl('https://github.com/Kordi-AI/Kordi/tree/main/bridges');
                          }}
                        >
                          Open Kordi Bridges source
                        </Button>
                      </div>
                    </div>
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
                        <div className="mt-1 break-all text-slate-400">{activeDefaultAgent?.id || 'Pending'}</div>
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
                      Next step: finish configuring your hosted bridge from the Kordi repo, then return here with the final service URL. Kordi Desktop already includes the local bridge sidecar, so no separate client install is required just to connect.
                    </div>
                    <div className="grid gap-2.5 md:grid-cols-2">
                      <Button
                        variant="secondary"
                        className="justify-center rounded-[14px] text-[12px]"
                        onClick={() => {
                          void openDesktopExternalUrl('https://github.com/Kordi-AI/Kordi/blob/main/bridges/docs/self-host-guide.md');
                        }}
                      >
                        <ExternalLink className="mr-2 h-4 w-4" /> Server setup guide
                      </Button>
                      <Button
                        variant="secondary"
                        className="justify-center rounded-[14px] text-[12px]"
                        onClick={() => {
                          void openDesktopExternalUrl('https://github.com/Kordi-AI/Kordi/tree/main/bridges');
                        }}
                      >
                        Open Kordi Bridges source
                      </Button>
                    </div>
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
                    {bridgeWizardDraft.mode === 'have-url' ? 'Bridge setup is complete.' : 'Once your hosted bridge is ready, come back and connect it here.'}
                  </div>
                  <div className="app-bridge-meta-block rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[12px] leading-5 text-slate-300">
                    {bridgeWizardDraft.mode === 'have-url'
                      ? 'Next: confirm your identity, pick your default agent, then start discovering people and agents on this host.'
                      : 'You do not need to enter a URL in this wizard yet. Finish the hosting flow first, then return with the final hosted service URL.'}
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
              <Button className="rounded-[14px]" onClick={onBridgeWizardPrimary} disabled={bridgeWizardStep === 1 && bridgeWizardDraft.mode === 'have-url' && !bridgeWizardDraft.serverUrl.trim()}>
                {bridgeWizardStep === 3 ? 'Done' : 'Continue'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
