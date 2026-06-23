import { useEffect, useState } from 'react';
import { Check, ChevronRight, Copy, Link2, Plus, Star } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DEFAULT_BRIDGE_DISPLAY_NAME,
  DEFAULT_BRIDGE_OWNER_NAME,
} from '@/features/bridge/constants';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';
import type { DesktopBridgePeer } from '@/kordi-app/types';

import type {
  AgentReachabilityPolicy,
  BridgeDetailsSectionProps,
  ContactApprovalPolicy,
  HumanVisibilityPolicy,
} from './BridgeConfigPage.types';
import {
  AGENT_REACHABILITY_OPTIONS,
  EmptyState,
  agentReachabilityLabel,
} from './BridgeConfigShared';

type BridgePrivacyModeId = 'private' | 'approval' | 'open';
type ReachabilitySaveState = 'idle' | 'saving' | 'saved' | 'error';

type BridgePrivacyMode = {
  id: BridgePrivacyModeId;
  label: string;
  summary: string;
  detail: string;
  humanVisibilityPolicy: HumanVisibilityPolicy;
  contactApprovalPolicy: ContactApprovalPolicy;
  recommended?: boolean;
};

const PRIVATE_BRIDGE_PRIVACY_MODE: BridgePrivacyMode = {
  id: 'private',
  label: 'Private / invite only',
  summary: 'Hidden from discovery.',
  detail: 'Only saved contacts, shared projects, or invites can reach you. New direct contacts still need approval.',
  humanVisibilityPolicy: 'private',
  contactApprovalPolicy: 'approval-required',
};

const APPROVAL_BRIDGE_PRIVACY_MODE: BridgePrivacyMode = {
  id: 'approval',
  label: 'Listed, approve new people',
  summary: 'People can find you, but direct contact waits for your approval.',
  detail: 'Recommended privacy setting. Discovery works, but unknown people cannot reach you until you approve them.',
  humanVisibilityPolicy: 'server-approval',
  contactApprovalPolicy: 'approval-required',
  recommended: true,
};

const OPEN_BRIDGE_PRIVACY_MODE: BridgePrivacyMode = {
  id: 'open',
  label: 'Open on this host',
  summary: 'People can find and contact you immediately.',
  detail: 'Least private. Anyone signed into this Bridges host can start direct contact without waiting for approval.',
  humanVisibilityPolicy: 'server-open',
  contactApprovalPolicy: 'auto',
};

const BRIDGE_PRIVACY_MODES: BridgePrivacyMode[] = [
  PRIVATE_BRIDGE_PRIVACY_MODE,
  APPROVAL_BRIDGE_PRIVACY_MODE,
  OPEN_BRIDGE_PRIVACY_MODE,
];

function bridgePrivacyModeById(modeId: BridgePrivacyModeId) {
  return BRIDGE_PRIVACY_MODES.find((mode) => mode.id === modeId) ?? APPROVAL_BRIDGE_PRIVACY_MODE;
}

function bridgePrivacyModeForPolicies(humanVisibilityPolicy?: string | null, contactApprovalPolicy?: string | null) {
  const normalizedHumanVisibility = (humanVisibilityPolicy ?? '').toLowerCase();
  const normalizedContactApproval = (contactApprovalPolicy ?? '').toLowerCase();

  if (normalizedHumanVisibility === 'private') {
    return PRIVATE_BRIDGE_PRIVACY_MODE;
  }
  if (normalizedHumanVisibility === 'server-open' && normalizedContactApproval === 'auto') {
    return OPEN_BRIDGE_PRIVACY_MODE;
  }
  return APPROVAL_BRIDGE_PRIVACY_MODE;
}

function normalizeAgentReachabilityPolicy(value?: string | null): AgentReachabilityPolicy {
  const normalized = (value ?? '').toLowerCase();
  if (normalized === 'server' || normalized === 'owner' || normalized === 'contacts') {
    return normalized;
  }
  return 'contacts';
}

type ReachabilityPolicyAgent = {
  id: string;
  reachabilityPolicy?: string | null;
};

export function pendingAgentReachabilityPolicySaves(
  agents: ReachabilityPolicyAgent[],
  draftByAgent: Record<string, AgentReachabilityPolicy>,
) {
  return agents.flatMap((agent) => {
    const saved = normalizeAgentReachabilityPolicy(agent.reachabilityPolicy);
    const selected = draftByAgent[agent.id] ?? saved;
    return selected === saved ? [] : [{ agentId: agent.id, reachabilityPolicy: selected }];
  });
}

export function agentReachabilityStatusText(
  selectedReachabilityPolicy: AgentReachabilityPolicy,
  reachabilitySaveState: ReachabilitySaveState,
  hasPendingChange: boolean,
) {
  const selectedReachabilityLabel = agentReachabilityLabel(selectedReachabilityPolicy);
  if (reachabilitySaveState === 'saving') return `Saving ${selectedReachabilityLabel.toLowerCase()}…`;
  if (reachabilitySaveState === 'error') return 'Could not update. Try another option again.';
  if (reachabilitySaveState === 'saved') return `${selectedReachabilityLabel} • Saved`;
  if (hasPendingChange) return `${selectedReachabilityLabel} • Not saved`;
  return selectedReachabilityLabel;
}

export function BridgeDetailsSection({
  activeBridgeHost,
  activeBridgePeople,
  activeBridgeAgents,
  bridgeSettingsDraft,
  setBridgeSettingsDraft,
  isDesktopBridgeSaving,
  onSaveBridgeSettings,
  onCopyBridgeText,
  onSetBridgeHostPrivacyPolicy,
  onSetBridgeAgentReachabilityPolicy,
  onCreateBridgeAgent,
  onActivateBridgeAgent,
  onSetDefaultBridgeAgent,
  onRemoveBridgeContact,
  onOpenBridgeConversation,
  activeStep,
  setActiveStep,
  setActiveSection,
  identityOwnerName,
  setIdentityOwnerName,
}: BridgeDetailsSectionProps) {
  if (!activeBridgeHost) {
    return <EmptyState title="Select a host first" detail="Choose one of your saved hosts to adjust how you appear, which agents you use, and who you can reach." />;
  }

  const activeDefaultAgent = activeBridgeHost.agents.find((agent) => agent.isDefault) ?? activeBridgeHost.agents[0] ?? null;
  const activePrivacyMode = bridgePrivacyModeForPolicies(activeBridgeHost.humanVisibilityPolicy, activeBridgeHost.contactApprovalPolicy);
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
            <OverviewStat title="Privacy mode" value={activePrivacyMode.label} detail={`${activePrivacyMode.summary} • Node ID: ${activeBridgeHost.nodeId || 'pending registration'}`} breakAll />
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

          </div>
          <BridgeInlineTimeline
            activeBridgeHost={activeBridgeHost}
            activeBridgePeople={activeBridgePeople}
            activeBridgeAgents={activeBridgeAgents}
            activeDefaultAgent={activeDefaultAgent}
            activeStep={activeStep}
            bridgeSettingsDraft={bridgeSettingsDraft}
            identityNameChanged={identityNameChanged}
            identityOwnerName={identityOwnerName}
            isDesktopBridgeSaving={isDesktopBridgeSaving}
            setActiveStep={setActiveStep}
            setBridgeSettingsDraft={setBridgeSettingsDraft}
            setIdentityOwnerName={setIdentityOwnerName}
            onActivateBridgeAgent={onActivateBridgeAgent}
            onCopyBridgeText={onCopyBridgeText}
            onCreateBridgeAgent={onCreateBridgeAgent}
            onOpenBridgeConversation={onOpenBridgeConversation}
            onRemoveBridgeContact={onRemoveBridgeContact}
            onSaveBridgeSettings={onSaveBridgeSettings}
            onSetBridgeAgentReachabilityPolicy={onSetBridgeAgentReachabilityPolicy}
            onSetBridgeHostPrivacyPolicy={onSetBridgeHostPrivacyPolicy}
            onSetDefaultBridgeAgent={onSetDefaultBridgeAgent}
            trimmedIdentityOwnerName={trimmedIdentityOwnerName}
          />
        </CardContent>
      </Card>
    </div>
  );
}

type InlineBridgeStepId = 'identity' | 'visibility' | 'agents' | 'review';

function BridgeInlineTimeline({
  activeBridgeHost,
  activeBridgePeople,
  activeBridgeAgents,
  activeDefaultAgent,
  activeStep,
  bridgeSettingsDraft,
  identityNameChanged,
  identityOwnerName,
  isDesktopBridgeSaving,
  setActiveStep,
  setBridgeSettingsDraft,
  setIdentityOwnerName,
  onActivateBridgeAgent,
  onCopyBridgeText,
  onCreateBridgeAgent,
  onOpenBridgeConversation,
  onRemoveBridgeContact,
  onSaveBridgeSettings,
  onSetBridgeAgentReachabilityPolicy,
  onSetBridgeHostPrivacyPolicy,
  onSetDefaultBridgeAgent,
  trimmedIdentityOwnerName,
}: {
  activeBridgeHost: NonNullable<BridgeDetailsSectionProps['activeBridgeHost']>;
  activeBridgePeople: BridgeDetailsSectionProps['activeBridgePeople'];
  activeBridgeAgents: BridgeDetailsSectionProps['activeBridgeAgents'];
  activeDefaultAgent: ReturnType<typeof findDefaultAgent>;
  activeStep: BridgeDetailsSectionProps['activeStep'];
  bridgeSettingsDraft: BridgeDetailsSectionProps['bridgeSettingsDraft'];
  identityNameChanged: boolean;
  identityOwnerName: string;
  isDesktopBridgeSaving: boolean;
  setActiveStep: BridgeDetailsSectionProps['setActiveStep'];
  setBridgeSettingsDraft: BridgeDetailsSectionProps['setBridgeSettingsDraft'];
  setIdentityOwnerName: BridgeDetailsSectionProps['setIdentityOwnerName'];
  onActivateBridgeAgent: BridgeDetailsSectionProps['onActivateBridgeAgent'];
  onCopyBridgeText: BridgeDetailsSectionProps['onCopyBridgeText'];
  onCreateBridgeAgent: BridgeDetailsSectionProps['onCreateBridgeAgent'];
  onOpenBridgeConversation: BridgeDetailsSectionProps['onOpenBridgeConversation'];
  onRemoveBridgeContact: BridgeDetailsSectionProps['onRemoveBridgeContact'];
  onSaveBridgeSettings: BridgeDetailsSectionProps['onSaveBridgeSettings'];
  onSetBridgeAgentReachabilityPolicy: BridgeDetailsSectionProps['onSetBridgeAgentReachabilityPolicy'];
  onSetBridgeHostPrivacyPolicy: BridgeDetailsSectionProps['onSetBridgeHostPrivacyPolicy'];
  onSetDefaultBridgeAgent: BridgeDetailsSectionProps['onSetDefaultBridgeAgent'];
  trimmedIdentityOwnerName: string;
}) {
  const normalizedActiveStep: InlineBridgeStepId = activeStep === 'setup'
    ? 'identity'
    : activeStep === 'discover' || activeStep === 'approvals'
      ? 'agents'
      : activeStep;
  const needsRegistration = !activeBridgeHost.registered;
  const steps: Array<{ id: InlineBridgeStepId; title: string; detail: string; disabled?: boolean }> = [
    { id: 'identity', title: 'How you appear', detail: 'Name, host share text, and public Bridge identity.' },
    { id: 'visibility', title: 'Visibility', detail: 'Discovery, private mode, and contact approval policy.', disabled: needsRegistration },
    { id: 'agents', title: 'Agent reachability', detail: 'Active/default agent plus who can call each agent.', disabled: needsRegistration },
    { id: 'review', title: 'Review', detail: 'Effective host strategy and visible peers.', disabled: needsRegistration },
  ];
  const activeIndex = steps.findIndex((step) => step.id === normalizedActiveStep);

  const renderStepBody = (stepId: InlineBridgeStepId) => {
    switch (stepId) {
      case 'identity':
        return (
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
            setActiveStep={setActiveStep}
            trimmedIdentityOwnerName={trimmedIdentityOwnerName}
          />
        );
      case 'visibility':
        return (
          <BridgeVisibilityStep
            activeBridgeHost={activeBridgeHost}
            onSetBridgeHostPrivacyPolicy={onSetBridgeHostPrivacyPolicy}
            setActiveStep={setActiveStep}
          />
        );
      case 'agents':
        return (
          <BridgeAgentsStep
            activeBridgeHost={activeBridgeHost}
            onCreateBridgeAgent={onCreateBridgeAgent}
            onActivateBridgeAgent={onActivateBridgeAgent}
            onSetDefaultBridgeAgent={onSetDefaultBridgeAgent}
            onSetBridgeAgentReachabilityPolicy={onSetBridgeAgentReachabilityPolicy}
            setActiveStep={setActiveStep}
          />
        );
      case 'review':
        return (
          <BridgeReviewStep
            activeBridgeHost={activeBridgeHost}
            activeBridgePeople={activeBridgePeople}
            activeBridgeAgents={activeBridgeAgents}
            activeDefaultAgent={activeDefaultAgent}
            bridgeSettingsDraft={bridgeSettingsDraft}
            identityOwnerName={identityOwnerName}
            isDesktopBridgeSaving={isDesktopBridgeSaving}
            onRemoveBridgeContact={onRemoveBridgeContact}
            onOpenBridgeConversation={onOpenBridgeConversation}
            onSaveBridgeSettings={onSaveBridgeSettings}
            setBridgeSettingsDraft={setBridgeSettingsDraft}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="app-bridge-detail-nav app-bridge-timeline app-bridge-inline-timeline space-y-2">
      {steps.map((step, index) => {
        const active = step.id === normalizedActiveStep;
        const complete = !active && activeIndex > index;
        return (
          <div key={step.id} className={cn('app-bridge-timeline-segment rounded-[20px]', active ? 'is-active' : '', step.disabled ? 'is-disabled' : '')}>
            <button
              type="button"
              disabled={step.disabled}
              aria-expanded={active}
              onClick={() => setActiveStep(step.id)}
              className={cn(
                'app-bridge-timeline-step flex w-full items-start gap-3 rounded-[18px] border px-3 py-3 text-left transition',
                active ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
                step.disabled ? 'cursor-not-allowed opacity-45 hover:bg-white/[0.04]' : '',
              )}
            >
              <span className={cn('app-bridge-timeline-dot mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[10px]', active ? 'border-cyan-300/40 bg-cyan-300/15 text-cyan-100' : complete ? 'border-emerald-300/30 bg-emerald-300/12 text-emerald-100' : 'border-white/10 bg-white/[0.04] text-[var(--app-text-muted)]')}>
                {complete ? '✓' : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium text-white">{step.title}</span>
                <span className="mt-1 block text-[11px] leading-5 text-slate-400">{step.detail}</span>
              </span>
              <span className="mt-1 flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                {active ? 'Open' : complete ? 'Done' : 'Next'}
                <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', active ? 'rotate-90 text-slate-300' : 'text-slate-500')} />
              </span>
            </button>
            {active ? (
              <div className="app-bridge-step-detail-region" role="region" aria-label={step.title}>
                <div className="app-bridge-step-detail-inner">
                  {renderStepBody(step.id)}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
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
  setActiveStep,
  trimmedIdentityOwnerName,
}: {
  activeBridgeHost: NonNullable<BridgeDetailsSectionProps['activeBridgeHost']>;
  activeDefaultAgent: ReturnType<typeof findDefaultAgent>;
  bridgeSettingsDraft: BridgeDetailsSectionProps['bridgeSettingsDraft'];
  setBridgeSettingsDraft: BridgeDetailsSectionProps['setBridgeSettingsDraft'];
  identityOwnerName: string;
  setIdentityOwnerName: BridgeDetailsSectionProps['setIdentityOwnerName'];
  identityNameChanged: boolean;
  isDesktopBridgeSaving: boolean;
  onSaveBridgeSettings: BridgeDetailsSectionProps['onSaveBridgeSettings'];
  onCopyBridgeText: BridgeDetailsSectionProps['onCopyBridgeText'];
  setActiveStep: BridgeDetailsSectionProps['setActiveStep'];
  trimmedIdentityOwnerName: string;
}) {
  const activePrivacyMode = bridgePrivacyModeForPolicies(activeBridgeHost.humanVisibilityPolicy, activeBridgeHost.contactApprovalPolicy);

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
                void onSaveBridgeSettings({
                  hostId: bridgeSettingsDraft?.hostId ?? activeBridgeHost.id,
                  serverUrl: bridgeSettingsDraft?.serverUrl || activeBridgeHost.serverUrl,
                  displayName: bridgeSettingsDraft?.displayName || activeBridgeHost.displayName || DEFAULT_BRIDGE_DISPLAY_NAME,
                  ownerName: trimmedIdentityOwnerName,
                }).catch(() => {});
              }}
            >
              {isDesktopBridgeSaving ? 'Saving…' : 'Save name'}
            </Button>
          </div>
        </div>

        <div className="app-bridge-meta-block rounded-[18px] px-3 py-3 text-[12px] leading-5 text-slate-400">
          Current privacy mode: <span className="text-slate-200">{activePrivacyMode.label}</span>. {activePrivacyMode.summary} Visibility settings are reviewed next so privacy controls stay separate from naming.
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
          <Button className="rounded-[14px] text-[12px]" onClick={() => setActiveStep('visibility')} disabled={!activeBridgeHost.registered}>
            Next: set visibility <ChevronRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BridgeVisibilityStep({
  activeBridgeHost,
  onSetBridgeHostPrivacyPolicy,
  setActiveStep,
}: {
  activeBridgeHost: NonNullable<BridgeDetailsSectionProps['activeBridgeHost']>;
  onSetBridgeHostPrivacyPolicy: BridgeDetailsSectionProps['onSetBridgeHostPrivacyPolicy'];
  setActiveStep: BridgeDetailsSectionProps['setActiveStep'];
}) {
  const savedPrivacyMode = bridgePrivacyModeForPolicies(activeBridgeHost.humanVisibilityPolicy, activeBridgeHost.contactApprovalPolicy);
  const [draftPrivacyModeId, setDraftPrivacyModeId] = useState<BridgePrivacyModeId>(savedPrivacyMode.id);
  const [policySaveState, setPolicySaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setDraftPrivacyModeId(savedPrivacyMode.id);
  }, [savedPrivacyMode.id]);

  useEffect(() => {
    setPolicySaveState('idle');
  }, [activeBridgeHost.id]);

  const selectPrivacyMode = (nextMode: BridgePrivacyMode) => {
    setDraftPrivacyModeId(nextMode.id);
    setPolicySaveState('idle');
  };

  const activePrivacyMode = bridgePrivacyModeById(draftPrivacyModeId);
  const hasPrivacyModeChanges = draftPrivacyModeId !== savedPrivacyMode.id;
  const handleContinueFromPrivacyMode = () => {
    if (!hasPrivacyModeChanges) {
      setActiveStep('agents');
      return;
    }

    setPolicySaveState('saving');
    void onSetBridgeHostPrivacyPolicy(activeBridgeHost.id, activePrivacyMode.humanVisibilityPolicy, activePrivacyMode.contactApprovalPolicy)
      .then(() => {
        setPolicySaveState('saved');
        setActiveStep('agents');
      })
      .catch(() => {
        setPolicySaveState('error');
      });
  };
  const policyStatusText = policySaveState === 'saving'
    ? 'Saving privacy mode…'
    : policySaveState === 'error'
      ? 'Could not save. Try again before continuing.'
      : hasPrivacyModeChanges
        ? 'Not saved yet. This privacy mode will be saved when you continue.'
        : 'Saved on this host.';

  return (
    <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Discovery visibility and private protection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-300">
        <div className="text-[12px] leading-5 text-slate-400">
          Pick one privacy mode. Each mode bundles discovery and approval behavior; your choice is saved when you continue.
        </div>
        <div className="app-bridge-privacy-mode-list overflow-hidden rounded-[18px] border border-white/10 bg-white/[0.025]" role="radiogroup" aria-label="Bridge privacy mode">
          {BRIDGE_PRIVACY_MODES.map((mode, index) => {
            const active = mode.id === draftPrivacyModeId;
            return (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-pressed={active}
                aria-label={`${mode.label}${active ? ' selected' : ''}. ${mode.summary} ${mode.detail}`}
                disabled={policySaveState === 'saving'}
                onClick={() => selectPrivacyMode(mode)}
                className={cn(
                  'app-bridge-privacy-mode-row flex w-full items-start gap-3 px-3 py-3 text-left transition',
                  index > 0 ? 'border-t border-white/8' : '',
                  active ? 'is-selected bg-cyan-300/[0.08]' : 'hover:bg-white/[0.045]',
                  policySaveState === 'saving' ? 'cursor-wait opacity-70' : '',
                )}
              >
                <span className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px]', active ? 'border-cyan-300/50 bg-cyan-300/12 text-cyan-50' : 'border-white/12 bg-white/[0.03] text-transparent')}>
                  {active ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-medium text-white">{mode.label}</span>
                    {mode.recommended ? (
                      <span className="rounded-full border border-emerald-300/18 bg-emerald-300/8 px-2 py-0.5 text-[10px] font-medium text-emerald-100">Recommended</span>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-[11px] leading-5 text-slate-400">{mode.summary}</span>
                  <span className="mt-0.5 block text-[11px] leading-5 text-slate-500">{mode.detail}</span>
                </span>
                {active ? <span className="mt-0.5 shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-100">Selected</span> : null}
              </button>
            );
          })}
        </div>
        <div className="app-bridge-policy-summary app-bridge-meta-block flex flex-col gap-1 rounded-[16px] px-3 py-2.5 text-[12px] leading-5 text-slate-400 sm:flex-row sm:items-center sm:justify-between" aria-live="polite">
          <div>
            Current privacy mode: <span className="text-slate-200">{activePrivacyMode.label}</span>
          </div>
          <div className={cn('text-[11px]', policySaveState === 'error' ? 'text-rose-200' : policySaveState === 'saving' ? 'text-cyan-100' : 'text-emerald-100')}>
            {policyStatusText}
          </div>
        </div>
        <div className="flex justify-end border-t border-white/8 pt-3">
          <Button className="h-8 rounded-full px-3 text-[11px]" onClick={handleContinueFromPrivacyMode} disabled={!activeBridgeHost.registered || policySaveState === 'saving'}>
            {policySaveState === 'saving' ? 'Saving…' : hasPrivacyModeChanges ? 'Save & next: agent reachability' : 'Next: agent reachability'} <ChevronRight className="ml-1.5 h-3.5 w-3.5" />
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
  onSetBridgeAgentReachabilityPolicy,
  setActiveStep,
}: {
  activeBridgeHost: NonNullable<BridgeDetailsSectionProps['activeBridgeHost']>;
  onCreateBridgeAgent: BridgeDetailsSectionProps['onCreateBridgeAgent'];
  onActivateBridgeAgent: BridgeDetailsSectionProps['onActivateBridgeAgent'];
  onSetDefaultBridgeAgent: BridgeDetailsSectionProps['onSetDefaultBridgeAgent'];
  onSetBridgeAgentReachabilityPolicy: BridgeDetailsSectionProps['onSetBridgeAgentReachabilityPolicy'];
  setActiveStep: BridgeDetailsSectionProps['setActiveStep'];
}) {
  const [reachabilityDraftByAgent, setReachabilityDraftByAgent] = useState<Record<string, AgentReachabilityPolicy>>({});
  const [reachabilitySaveStateByAgent, setReachabilitySaveStateByAgent] = useState<Record<string, ReachabilitySaveState>>({});
  const reachabilityPolicySignature = activeBridgeHost.agents
    .map((agent) => `${agent.id}:${normalizeAgentReachabilityPolicy(agent.reachabilityPolicy)}`)
    .join('|');

  useEffect(() => {
    const nextDraftByAgent = Object.fromEntries(
      activeBridgeHost.agents.map((agent) => [
        agent.id,
        normalizeAgentReachabilityPolicy(agent.reachabilityPolicy),
      ]),
    );
    setReachabilityDraftByAgent(nextDraftByAgent);
    setReachabilitySaveStateByAgent({});
  }, [activeBridgeHost.id, reachabilityPolicySignature]);

  const pendingReachabilitySaves = pendingAgentReachabilityPolicySaves(activeBridgeHost.agents, reachabilityDraftByAgent);
  const isSavingReachability = Object.values(reachabilitySaveStateByAgent).some((state) => state === 'saving');

  const handleContinueFromAgents = async () => {
    const saves = pendingAgentReachabilityPolicySaves(activeBridgeHost.agents, reachabilityDraftByAgent);
    if (saves.length === 0) {
      setActiveStep('review');
      return;
    }

    const savingAgentIds = new Set(saves.map((save) => save.agentId));
    setReachabilitySaveStateByAgent((current) => ({
      ...current,
      ...Object.fromEntries(saves.map((save) => [save.agentId, 'saving' as ReachabilitySaveState])),
    }));

    try {
      for (const save of saves) {
        await onSetBridgeAgentReachabilityPolicy(activeBridgeHost.id, save.agentId, save.reachabilityPolicy);
      }
      setReachabilitySaveStateByAgent((current) => ({
        ...current,
        ...Object.fromEntries(saves.map((save) => [save.agentId, 'saved' as ReachabilitySaveState])),
      }));
      setActiveStep('review');
    } catch {
      setReachabilitySaveStateByAgent((current) => ({
        ...current,
        ...Object.fromEntries([...savingAgentIds].map((agentId) => [agentId, 'error' as ReachabilitySaveState])),
      }));
    }
  };

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
            {activeBridgeHost.agents.map((agent) => {
              const savedReachabilityPolicy = normalizeAgentReachabilityPolicy(agent.reachabilityPolicy);
              const selectedReachabilityPolicy = reachabilityDraftByAgent[agent.id] ?? savedReachabilityPolicy;
              const reachabilitySaveState = reachabilitySaveStateByAgent[agent.id] ?? 'idle';
              const hasPendingReachabilityChange = selectedReachabilityPolicy !== savedReachabilityPolicy;
              const reachabilityStatusText = agentReachabilityStatusText(
                selectedReachabilityPolicy,
                reachabilitySaveState,
                hasPendingReachabilityChange,
              );

              return (
                <div key={agent.id} className="app-bridge-list-item rounded-[18px] border border-white/10 bg-white/[0.04] px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <IdentityAvatar
                      kind="agent"
                      seed={agent.id}
                      name={agent.label}
                      imageUrl={agent.profileImageUrl}
                      className="mt-0.5 h-10 w-10 border border-white/10"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[13px] font-medium text-white">{agent.label}</div>
                        {agent.isActive ? <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-1 text-[11px] leading-none text-cyan-100">Active</span> : null}
                        {agent.isDefault ? <span className="rounded-full border border-white/12 bg-white/[0.05] px-2 py-1 text-[11px] leading-none text-slate-200">Default</span> : null}
                        <span className={cn('rounded-full border px-2 py-1 text-[11px] leading-none', agent.registered ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100' : 'border-amber-400/20 bg-amber-400/10 text-amber-100')}>
                          {agent.registered ? 'Registered' : 'Local only'}
                        </span>
                      </div>
                      <div
                        className={cn(
                          'mt-1 text-[12px]',
                          reachabilitySaveState === 'error' ? 'text-rose-200' : reachabilitySaveState === 'saving' ? 'text-cyan-100' : 'text-slate-400',
                        )}
                        aria-live="polite"
                      >
                        {agent.runtime} • {reachabilityStatusText}
                      </div>
                      <div className="mt-1 break-all text-[12px] text-slate-500">Agent ID: {agent.id}</div>
                      <div className="mt-1 break-all text-[12px] text-slate-500">Node ID: {agent.nodeId || 'pending registration'}</div>
                      <div
                        className="mt-2 grid gap-2 md:grid-cols-3"
                        role="radiogroup"
                        aria-label={`Agent reachability for ${agent.label}`}
                      >
                        {AGENT_REACHABILITY_OPTIONS.map((option) => {
                          const active = selectedReachabilityPolicy === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              aria-label={`${option.label}${active ? ' selected' : ''}: ${option.detail}`}
                              onClick={() => {
                                if (active) return;
                                setReachabilityDraftByAgent((current) => ({ ...current, [agent.id]: option.value }));
                                setReachabilitySaveStateByAgent((current) => ({ ...current, [agent.id]: 'idle' }));
                              }}
                              className={cn(
                                'group rounded-[14px] border px-3 py-2 text-left text-[11px] transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60',
                                active
                                  ? 'border-cyan-200/35 bg-cyan-300/[0.10] text-white shadow-[0_0_0_1px_rgba(103,232,249,0.12)]'
                                  : 'border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/18 hover:bg-white/[0.07] hover:text-slate-200',
                              )}
                            >
                              <div className="flex items-start gap-2">
                                <span
                                  className={cn(
                                    'mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border transition',
                                    active ? 'border-cyan-200 bg-cyan-300/20' : 'border-white/18 bg-white/[0.03] group-hover:border-white/30',
                                  )}
                                  aria-hidden="true"
                                >
                                  <span className={cn('h-1.5 w-1.5 rounded-full bg-cyan-100 transition', active ? 'opacity-100' : 'opacity-0')} />
                                </span>
                                <span className="min-w-0">
                                  <span className="block font-medium">{option.label}</span>
                                  <span className={cn('mt-1 block leading-4', active ? 'text-cyan-50/70' : 'text-slate-500')}>{option.detail}</span>
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
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
              );
            })}
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
            <Button className="rounded-[14px] text-[12px]" onClick={() => { void handleContinueFromAgents(); }} disabled={!activeBridgeHost.registered || isSavingReachability}>
              {isSavingReachability ? 'Saving reachability…' : pendingReachabilitySaves.length > 0 ? 'Save & next: review' : 'Next: review'} <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BridgeReviewStep({
  activeBridgeHost,
  activeBridgePeople,
  activeBridgeAgents,
  activeDefaultAgent,
  bridgeSettingsDraft,
  identityOwnerName,
  isDesktopBridgeSaving,
  onRemoveBridgeContact,
  onOpenBridgeConversation,
  onSaveBridgeSettings,
  setBridgeSettingsDraft,
}: {
  activeBridgeHost: NonNullable<BridgeDetailsSectionProps['activeBridgeHost']>;
  activeBridgePeople: BridgeDetailsSectionProps['activeBridgePeople'];
  activeBridgeAgents: BridgeDetailsSectionProps['activeBridgeAgents'];
  activeDefaultAgent: ReturnType<typeof findDefaultAgent>;
  bridgeSettingsDraft: BridgeDetailsSectionProps['bridgeSettingsDraft'];
  identityOwnerName: string;
  isDesktopBridgeSaving: boolean;
  onRemoveBridgeContact: BridgeDetailsSectionProps['onRemoveBridgeContact'];
  onOpenBridgeConversation: BridgeDetailsSectionProps['onOpenBridgeConversation'];
  onSaveBridgeSettings: BridgeDetailsSectionProps['onSaveBridgeSettings'];
  setBridgeSettingsDraft: BridgeDetailsSectionProps['setBridgeSettingsDraft'];
}) {
  const ownerNameForSave = identityOwnerName.trim() || activeBridgeHost.ownerName.trim() || DEFAULT_BRIDGE_OWNER_NAME;
  const activePrivacyMode = bridgePrivacyModeForPolicies(activeBridgeHost.humanVisibilityPolicy, activeBridgeHost.contactApprovalPolicy);
  const contactBehavior = activePrivacyMode.contactApprovalPolicy === 'auto'
    ? { value: 'Contact immediately', detail: 'New people can start direct contact without approval.' }
    : { value: 'Approve first', detail: `${(activeBridgeHost.contactRequests ?? []).filter((request) => request.status === 'pending').length} pending approval request(s)` };
  const finalDraft = {
    hostId: bridgeSettingsDraft?.hostId ?? activeBridgeHost.id,
    serverUrl: bridgeSettingsDraft?.serverUrl || activeBridgeHost.serverUrl,
    displayName: bridgeSettingsDraft?.displayName || activeBridgeHost.displayName || DEFAULT_BRIDGE_DISPLAY_NAME,
    ownerName: ownerNameForSave,
  };
  const [reviewSaveState, setReviewSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setReviewSaveState('idle');
  }, [activeBridgeHost.id, finalDraft.displayName, finalDraft.ownerName, finalDraft.serverUrl]);

  const reviewSaveStatusText = reviewSaveState === 'saving'
    ? 'Saving host profile…'
    : reviewSaveState === 'saved'
      ? 'Saved successfully.'
      : reviewSaveState === 'error'
        ? 'Could not save. Try again before leaving this page.'
        : '';

  return (
    <div className="w-full space-y-4">
      <Card className="app-bridge-card app-bridge-panel rounded-[26px] border-white/10 bg-white/5 shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Review current host strategy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-300">
        <OverviewStat
          title="Privacy mode"
          value={activePrivacyMode.label}
          detail={activePrivacyMode.detail}
        />
        <OverviewStat
          title="New people"
          value={contactBehavior.value}
          detail={contactBehavior.detail}
        />
        <OverviewStat
          title="Default agent reachability"
          value={agentReachabilityLabel(activeDefaultAgent?.reachabilityPolicy)}
          detail={activeDefaultAgent ? `${activeDefaultAgent.label} • ${activeDefaultAgent.nodeId || 'pending registration'}` : 'No default agent yet'}
          breakAll
        />
        <div className="app-bridge-meta-block rounded-[18px] px-3 py-3 text-[12px] leading-5 text-slate-400">
          This is the effective strategy after save/publish. Self-hosted Bridges serve enforces discovery listing, pending contact approval, and direct relay/key access where the server supports policy fields.
        </div>
        <div className="app-bridge-review-save app-bridge-meta-block flex flex-col gap-3 rounded-[18px] px-3 py-3 text-[12px] leading-5 text-slate-400 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="font-medium text-slate-200">Ready to finish?</div>
            <div className="mt-1">Save the host profile and confirm the published strategy.</div>
            <div
              className={cn(
                'app-bridge-review-save-status mt-2 min-h-4 text-[11px]',
                reviewSaveState === 'saved' ? 'text-emerald-100' : reviewSaveState === 'error' ? 'text-rose-200' : 'text-cyan-100',
              )}
              aria-live="polite"
            >
              {reviewSaveStatusText}
            </div>
          </div>
          <Button
            className="shrink-0 rounded-[14px] text-[12px]"
            disabled={isDesktopBridgeSaving || reviewSaveState === 'saving' || !finalDraft.serverUrl.trim()}
            onClick={() => {
              setReviewSaveState('saving');
              setBridgeSettingsDraft((current) => current ? { ...current, ...finalDraft } : finalDraft);
              void onSaveBridgeSettings(finalDraft)
                .then(() => setReviewSaveState('saved'))
                .catch(() => setReviewSaveState('error'));
            }}
          >
            {reviewSaveState === 'saved' ? <Check className="mr-1.5 h-3.5 w-3.5" /> : null}
            {isDesktopBridgeSaving || reviewSaveState === 'saving' ? 'Saving…' : reviewSaveState === 'saved' ? 'Saved' : reviewSaveState === 'error' ? 'Try saving again' : 'Save and finish'}
          </Button>
        </div>
      </CardContent>
    </Card>

      <div className="grid gap-3.5 lg:grid-cols-2">
        <BridgePeerListCard
          title="Visible people"
          emptyTitle="No people visible yet"
          emptyDetail="People appear here after your host visibility and agent reachability settings are configured."
          peers={activeBridgePeople}
          kind="person"
          activeBridgeHostId={activeBridgeHost.id}
          onRemoveBridgeContact={onRemoveBridgeContact}
          onOpenBridgeConversation={onOpenBridgeConversation}
        />
        <BridgePeerListCard
          title="Visible agents"
          emptyTitle="No agents visible yet"
          emptyDetail="Agents appear here after your host visibility and agent reachability settings are configured."
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

function compactBridgeId(value?: string | null) {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.length <= 18) return normalized;
  return `${normalized.slice(0, 8)}…${normalized.slice(-6)}`;
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
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">{title}</CardTitle>
          <div className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-slate-400">
            {peers.length}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5 text-sm text-slate-300">
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
  const title = peer.displayName || peer.ownerName || peer.nodeId;
  const compactHumanId = compactBridgeId(peer.humanId);
  const compactAgentId = compactBridgeId(peer.agentId);

  return (
    <div className="app-bridge-list-item rounded-[20px] border border-white/10 bg-white/[0.035] px-3 py-3 transition hover:bg-white/[0.055]">
      <div className="flex items-start gap-3">
        <IdentityAvatar
          kind={kind === 'person' ? 'human' : 'agent'}
          seed={kind === 'person' ? (peer.humanId || peer.ownerName || peer.nodeId) : (peer.agentId || peer.nodeId)}
          name={title}
          imageUrl={peer.profileImageUrl}
          className="h-9 w-9 border border-white/10"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-[13px] font-medium text-white">{title}</div>
            <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
              {kind === 'person' ? 'Person' : 'Agent'}
            </span>
            {kind === 'agent' && peer.isDefaultAgent ? <span className="rounded-full border border-white/12 bg-white/[0.05] px-2 py-1 text-[11px] leading-none text-slate-200">Default</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
            <span>{kind === 'person' ? 'Direct human chat' : `${peer.ownerName || 'Remote'} • ${peer.runtime}`}</span>
            {peer.sharedProjects.length > 0 ? <span className="text-slate-500">Shared: {peer.sharedProjects.join(' • ')}</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
            {compactHumanId ? (
              <span className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1 font-mono" title={peer.humanId || undefined}>
                human {compactHumanId}
              </span>
            ) : null}
            {compactAgentId ? (
              <span className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-1 font-mono" title={peer.agentId || undefined}>
                agent {compactAgentId}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            className="h-8 rounded-xl px-3 text-[11px]"
            onClick={() => onOpenBridgeConversation(
              activeBridgeHostId,
              peer.nodeId,
              peer.displayName,
              peer.ownerName,
              kind === 'person' ? 'person' : peer.runtime,
              {
                humanId: kind === 'person' ? peer.humanId : null,
                agentId: kind === 'agent' ? peer.agentId : null,
              },
            )}
          >
            Chat
          </Button>
          <Button variant="secondary" className="h-8 rounded-xl px-3 text-[11px] text-slate-400" onClick={() => { void onRemoveBridgeContact(activeBridgeHostId, peer.nodeId).catch(() => {}); }}>
            Remove
          </Button>
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
