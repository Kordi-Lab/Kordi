import { Bot, ChevronRight, Copy, Link2, Plus, Star, UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DEFAULT_BRIDGE_DISPLAY_NAME,
  DEFAULT_BRIDGE_OWNER_NAME,
} from '@/features/bridge/constants';
import { cn } from '@/lib/utils';
import type { DesktopBridgePeer } from '@/kordi-app/types';

import type { BridgeDetailsSectionProps } from './BridgeConfigPage.types';
import { DetailNav, DiscoveryModeSelector, EmptyState, discoveryLabel } from './BridgeConfigShared';

export function BridgeDetailsSection({
  activeBridgeHost,
  activeBridgePeople,
  activeBridgeAgents,
  bridgeSettingsDraft,
  setBridgeSettingsDraft,
  isDesktopBridgeSaving,
  onSaveBridgeSettings,
  onCopyBridgeText,
  onSetBridgeDiscoveryMode,
  onCreateBridgeAgent,
  onActivateBridgeAgent,
  onSetDefaultBridgeAgent,
  onAddBridgeContact,
  onRemoveBridgeContact,
  onOpenBridgeConversation,
  activeStep,
  setActiveStep,
  setActiveSection,
  contactNodeId,
  setContactNodeId,
  identityOwnerName,
  setIdentityOwnerName,
}: BridgeDetailsSectionProps) {
  if (!activeBridgeHost) {
    return <EmptyState title="Select a host first" detail="Choose one of your saved hosts to adjust how you appear, which agents you use, and who you can reach." />;
  }

  const activeDefaultAgent = activeBridgeHost.agents.find((agent) => agent.isDefault) ?? activeBridgeHost.agents[0] ?? null;
  const trimmedIdentityOwnerName = identityOwnerName.trim();
  const identityNameChanged = trimmedIdentityOwnerName.length > 0 && trimmedIdentityOwnerName !== activeBridgeHost.ownerName.trim();

  return (
    <div className="w-full space-y-4">
      <Card className="app-bridge-card app-bridge-overview-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Host identity and reachability</CardTitle>
              <div className="mt-1 break-all text-[12px] leading-5 text-slate-400">{activeBridgeHost.serverUrl}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => setActiveSection('servers')}>
                Back to hosts
              </Button>
              <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => setActiveSection('advanced')}>
                Files & recovery
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-slate-300">
          <div className="app-bridge-overview-grid grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <OverviewStat title="Status" value={activeBridgeHost.connected ? 'Connected' : 'Offline'} detail={`${activeBridgeHost.visiblePeerCount} visible on this host`} />
            <OverviewStat title="Your name" value={activeBridgeHost.ownerName} detail={`Human ID: ${activeBridgeHost.humanId}`} breakAll />
            <OverviewStat title="Default agent" value={activeDefaultAgent?.label || activeBridgeHost.displayName} detail={`Agent ID: ${activeDefaultAgent?.id || 'pending'}`} breakAll />
            <OverviewStat title="Visibility" value={discoveryLabel(activeBridgeHost.discoveryMode)} detail={`Node ID: ${activeBridgeHost.nodeId || 'pending registration'}`} breakAll />
          </div>
          <div className="app-bridge-toolbar flex flex-wrap gap-2">
            <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => onCopyBridgeText(activeBridgeHost.serverUrl, 'Bridge host URL copied')}>
              <Copy className="mr-2 h-4 w-4" /> Copy host URL
            </Button>
            <Button
              variant="secondary"
              className="rounded-[14px] text-[12px]"
              onClick={() => onCopyBridgeText(`Join my Kordi bridge host:\n${activeBridgeHost.serverUrl}\nHuman ID: ${activeBridgeHost.humanId}\nDefault agent ID: ${activeDefaultAgent?.id ?? 'pending agent'}\nNode: ${activeBridgeHost.nodeId ?? 'pending registration'}`, 'Bridge invite text copied')}
            >
              <Link2 className="mr-2 h-4 w-4" /> Copy invite text
            </Button>
            <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => setActiveStep('discover')} disabled={!activeBridgeHost.registered}>
              Open people & agents
            </Button>
          </div>
          <DetailNav activeStep={activeStep} setActiveStep={setActiveStep} activeBridgeHost={activeBridgeHost} />
        </CardContent>
      </Card>

      {activeStep === 'agents' ? (
        <BridgeAgentsStep
          activeBridgeHost={activeBridgeHost}
          onCreateBridgeAgent={onCreateBridgeAgent}
          onActivateBridgeAgent={onActivateBridgeAgent}
          onSetDefaultBridgeAgent={onSetDefaultBridgeAgent}
          setActiveStep={setActiveStep}
        />
      ) : null}
      {activeStep === 'discover' ? (
        <BridgeDiscoverStep
          activeBridgeHost={activeBridgeHost}
          activeBridgePeople={activeBridgePeople}
          activeBridgeAgents={activeBridgeAgents}
          contactNodeId={contactNodeId}
          setContactNodeId={setContactNodeId}
          onAddBridgeContact={onAddBridgeContact}
          onRemoveBridgeContact={onRemoveBridgeContact}
          onOpenBridgeConversation={onOpenBridgeConversation}
        />
      ) : null}
      {activeStep === 'identity' || activeStep === 'setup' ? (
        <BridgeIdentityStep
          activeBridgeHost={activeBridgeHost}
          activeDefaultAgent={activeDefaultAgent}
          bridgeSettingsDraft={bridgeSettingsDraft}
          setBridgeSettingsDraft={setBridgeSettingsDraft}
          identityOwnerName={identityOwnerName}
          setIdentityOwnerName={setIdentityOwnerName}
          identityNameChanged={identityNameChanged}
          isDesktopBridgeSaving={isDesktopBridgeSaving}
          onSaveBridgeSettings={onSaveBridgeSettings}
          onCopyBridgeText={onCopyBridgeText}
          onSetBridgeDiscoveryMode={onSetBridgeDiscoveryMode}
          setActiveStep={setActiveStep}
          trimmedIdentityOwnerName={trimmedIdentityOwnerName}
        />
      ) : null}
    </div>
  );
}

function BridgeIdentityStep({
  activeBridgeHost,
  activeDefaultAgent,
  bridgeSettingsDraft,
  setBridgeSettingsDraft,
  identityOwnerName,
  setIdentityOwnerName,
  identityNameChanged,
  isDesktopBridgeSaving,
  onSaveBridgeSettings,
  onCopyBridgeText,
  onSetBridgeDiscoveryMode,
  setActiveStep,
  trimmedIdentityOwnerName,
}: {
  activeBridgeHost: NonNullable<BridgeDetailsSectionProps['activeBridgeHost']>;
  activeDefaultAgent: NonNullable<ReturnType<typeof findDefaultAgent>>;
  bridgeSettingsDraft: BridgeDetailsSectionProps['bridgeSettingsDraft'];
  setBridgeSettingsDraft: BridgeDetailsSectionProps['setBridgeSettingsDraft'];
  identityOwnerName: string;
  setIdentityOwnerName: BridgeDetailsSectionProps['setIdentityOwnerName'];
  identityNameChanged: boolean;
  isDesktopBridgeSaving: boolean;
  onSaveBridgeSettings: BridgeDetailsSectionProps['onSaveBridgeSettings'];
  onCopyBridgeText: BridgeDetailsSectionProps['onCopyBridgeText'];
  onSetBridgeDiscoveryMode: BridgeDetailsSectionProps['onSetBridgeDiscoveryMode'];
  setActiveStep: BridgeDetailsSectionProps['setActiveStep'];
  trimmedIdentityOwnerName: string;
}) {
  return (
    <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
      <CardHeader>
        <CardTitle className="text-base">How you appear on this host</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-slate-300">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <OverviewStat title="Human" value={activeBridgeHost.ownerName} detail={`Human ID: ${activeBridgeHost.humanId}`} breakAll />
          <OverviewStat title="Default agent" value={activeDefaultAgent?.label || activeBridgeHost.displayName} detail={`Agent ID: ${activeDefaultAgent?.id || 'pending'}`} breakAll />
          <OverviewStat title="Current node" value={activeBridgeHost.connected ? 'Connected' : 'Offline'} detail={`Node ID: ${activeBridgeHost.nodeId || 'pending registration'}`} breakAll />
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
            People on this host will see this human name first. Agent names are managed separately on the <span className="text-slate-300">Agents</span> page.
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
                  displayName: bridgeSettingsDraft?.displayName || activeBridgeHost.displayName || DEFAULT_BRIDGE_DISPLAY_NAME,
                  ownerName: trimmedIdentityOwnerName,
                });
              }}
            >
              {isDesktopBridgeSaving ? 'Saving…' : 'Save name'}
            </Button>
          </div>
        </div>

        <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
          <div className="mb-2 text-[12px] font-medium text-white">Who should be able to find me?</div>
          <DiscoveryModeSelector activeBridgeHost={activeBridgeHost} onSetBridgeDiscoveryMode={onSetBridgeDiscoveryMode} />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="rounded-[14px] text-[12px]" onClick={() => onCopyBridgeText(activeBridgeHost.serverUrl, 'Bridge host URL copied')}>
            <Copy className="mr-2 h-4 w-4" /> Copy host URL
          </Button>
          <Button
            variant="secondary"
            className="rounded-[14px] text-[12px]"
            onClick={() => onCopyBridgeText(`Join my Kordi bridge host:\n${activeBridgeHost.serverUrl}\nHuman ID: ${activeBridgeHost.humanId}\nDefault agent ID: ${activeDefaultAgent?.id ?? 'pending agent'}\nNode: ${activeBridgeHost.nodeId ?? 'pending registration'}`, 'Bridge invite text copied')}
          >
            <Link2 className="mr-2 h-4 w-4" /> Copy invite text
          </Button>
          <Button className="rounded-[14px] text-[12px]" onClick={() => setActiveStep('agents')}>
            Next: choose an agent <ChevronRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BridgeAgentsStep({
  activeBridgeHost,
  onCreateBridgeAgent,
  onActivateBridgeAgent,
  onSetDefaultBridgeAgent,
  setActiveStep,
}: {
  activeBridgeHost: NonNullable<BridgeDetailsSectionProps['activeBridgeHost']>;
  onCreateBridgeAgent: BridgeDetailsSectionProps['onCreateBridgeAgent'];
  onActivateBridgeAgent: BridgeDetailsSectionProps['onActivateBridgeAgent'];
  onSetDefaultBridgeAgent: BridgeDetailsSectionProps['onSetDefaultBridgeAgent'];
  setActiveStep: BridgeDetailsSectionProps['setActiveStep'];
}) {
  return (
    <div className="w-full space-y-4">
      <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
        <CardHeader>
          <CardTitle className="text-base">My bridge agents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5 text-sm text-slate-300">
          <div className="text-[12px] leading-5 text-slate-400">
            Pick which agent is active right now and which one should be the default identity for this host. Rename agents later from the <span className="text-slate-200">Agents</span> page.
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
                          Make active
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
            <Button className="rounded-[14px] text-[12px]" onClick={() => { void onCreateBridgeAgent(activeBridgeHost.id).catch(() => {}); }}>
              <Plus className="mr-2 h-4 w-4" /> Create agent
            </Button>
          </div>
          <div className="flex justify-end">
            <Button className="rounded-[14px] text-[12px]" onClick={() => setActiveStep('discover')} disabled={!activeBridgeHost.registered}>
              Next: people & agents <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BridgeDiscoverStep({
  activeBridgeHost,
  activeBridgePeople,
  activeBridgeAgents,
  contactNodeId,
  setContactNodeId,
  onAddBridgeContact,
  onRemoveBridgeContact,
  onOpenBridgeConversation,
}: {
  activeBridgeHost: NonNullable<BridgeDetailsSectionProps['activeBridgeHost']>;
  activeBridgePeople: BridgeDetailsSectionProps['activeBridgePeople'];
  activeBridgeAgents: BridgeDetailsSectionProps['activeBridgeAgents'];
  contactNodeId: string;
  setContactNodeId: BridgeDetailsSectionProps['setContactNodeId'];
  onAddBridgeContact: BridgeDetailsSectionProps['onAddBridgeContact'];
  onRemoveBridgeContact: BridgeDetailsSectionProps['onRemoveBridgeContact'];
  onOpenBridgeConversation: BridgeDetailsSectionProps['onOpenBridgeConversation'];
}) {
  if (!activeBridgeHost.registered) {
    return <EmptyState title="Finish setup first" detail="Once this host finishes registering, direct contacts and discovery will appear here." />;
  }

  return (
    <div className="w-full space-y-4">
      <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Add someone by node ID</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-300">
          <div className="text-[12px] leading-5 text-slate-400">Already have someone’s node ID? Save it here and open a chat right away.</div>
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
            Current visibility: <span className="text-slate-200">{discoveryLabel(activeBridgeHost.discoveryMode)}</span>. Saved contacts and shared projects still work even when open discovery is off.
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3.5 lg:grid-cols-2">
        <BridgePeerListCard
          title="Visible people"
          emptyTitle="No people visible yet"
          emptyDetail="People appear here from contacts, shared projects, or open same-host discovery."
          peers={activeBridgePeople}
          kind="person"
          activeBridgeHostId={activeBridgeHost.id}
          onRemoveBridgeContact={onRemoveBridgeContact}
          onOpenBridgeConversation={onOpenBridgeConversation}
        />
        <BridgePeerListCard
          title="Visible agents"
          emptyTitle="No agents visible yet"
          emptyDetail="Agents appear here from contacts, shared projects, or open same-host discovery."
          peers={activeBridgeAgents}
          kind="agent"
          activeBridgeHostId={activeBridgeHost.id}
          onRemoveBridgeContact={onRemoveBridgeContact}
          onOpenBridgeConversation={onOpenBridgeConversation}
        />
      </div>
    </div>
  );
}

function BridgePeerListCard({
  title,
  emptyTitle,
  emptyDetail,
  peers,
  kind,
  activeBridgeHostId,
  onRemoveBridgeContact,
  onOpenBridgeConversation,
}: {
  title: string;
  emptyTitle: string;
  emptyDetail: string;
  peers: DesktopBridgePeer[];
  kind: 'person' | 'agent';
  activeBridgeHostId: string;
  onRemoveBridgeContact: BridgeDetailsSectionProps['onRemoveBridgeContact'];
  onOpenBridgeConversation: BridgeDetailsSectionProps['onOpenBridgeConversation'];
}) {
  return (
    <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-slate-300">
        {peers.length
          ? peers.map((peer) => (
            <BridgePeerCard
              key={peer.nodeId}
              peer={peer}
              kind={kind}
              activeBridgeHostId={activeBridgeHostId}
              onRemoveBridgeContact={onRemoveBridgeContact}
              onOpenBridgeConversation={onOpenBridgeConversation}
            />
          ))
          : <EmptyState title={emptyTitle} detail={emptyDetail} />}
      </CardContent>
    </Card>
  );
}

function BridgePeerCard({
  peer,
  kind,
  activeBridgeHostId,
  onRemoveBridgeContact,
  onOpenBridgeConversation,
}: {
  peer: DesktopBridgePeer;
  kind: 'person' | 'agent';
  activeBridgeHostId: string;
  onRemoveBridgeContact: BridgeDetailsSectionProps['onRemoveBridgeContact'];
  onOpenBridgeConversation: BridgeDetailsSectionProps['onOpenBridgeConversation'];
}) {
  return (
    <div className="app-bridge-list-item rounded-[18px] border border-white/10 bg-white/5 px-3 py-2.5">
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
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" className="h-7.5 rounded-xl px-3 text-[11px]" onClick={() => onOpenBridgeConversation(activeBridgeHostId, peer.nodeId, peer.displayName, peer.ownerName, peer.runtime)}>
              Open chat
            </Button>
            <Button variant="secondary" className="h-7.5 rounded-xl px-3 text-[11px]" onClick={() => { void onRemoveBridgeContact(activeBridgeHostId, peer.nodeId).catch(() => {}); }}>
              Remove contact
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function OverviewStat({ title, value, detail, breakAll = false }: { title: string; value: string; detail: string; breakAll?: boolean }) {
  return (
    <div className="app-bridge-meta-block rounded-[18px] px-3 py-3">
      <div className="mb-1 text-[12px] font-medium text-white">{title}</div>
      <div className="text-[13px] text-slate-200">{value}</div>
      <div className={cn('mt-1 text-[12px] text-slate-500', breakAll ? 'break-all' : '')}>{detail}</div>
    </div>
  );
}

function findDefaultAgent(activeBridgeHost: NonNullable<BridgeDetailsSectionProps['activeBridgeHost']>) {
  return activeBridgeHost.agents.find((agent) => agent.isDefault) ?? activeBridgeHost.agents[0] ?? null;
}
