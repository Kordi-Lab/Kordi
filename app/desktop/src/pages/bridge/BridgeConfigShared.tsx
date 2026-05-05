import type { Dispatch, SetStateAction } from 'react';

import { cn } from '@/lib/utils';
import type { DesktopBridgeHost } from '@/kordi-app/types';

import type {
  AgentReachabilityPolicy,
  BridgeConfigPageProps,
  BridgePageSection,
  BridgeStepId,
  ContactApprovalPolicy,
  DiscoveryMode,
  HumanVisibilityPolicy,
} from './BridgeConfigPage.types';

const DISCOVERY_OPTIONS: Array<{ value: DiscoveryMode; label: string; detail: string }> = [
  { value: 'off', label: 'Hidden', detail: 'Only saved contacts and shared projects can reach you.' },
  { value: 'contacts', label: 'Contacts + projects', detail: 'People you already know, plus shared projects, can find you.' },
  { value: 'open', label: 'Visible on this host', detail: 'Anyone on this host can discover you.' },
];

export const HUMAN_VISIBILITY_OPTIONS: Array<{ value: HumanVisibilityPolicy; label: string; detail: string }> = [
  { value: 'server-open', label: 'Visible + reachable', detail: 'Everyone signed into this host can discover and reach you.' },
  { value: 'server-approval', label: 'Visible, approval required', detail: 'People can find you, but direct contact waits for approval.' },
  { value: 'private', label: 'Private / invite only', detail: 'Hidden from discovery unless a contact, project, or invite connects you.' },
];

export const CONTACT_APPROVAL_OPTIONS: Array<{ value: ContactApprovalPolicy; label: string; detail: string }> = [
  { value: 'approval-required', label: 'Require approval', detail: 'New direct contacts appear as pending requests first.' },
  { value: 'auto', label: 'Auto-accept', detail: 'Contact requests become contacts immediately.' },
];

export const AGENT_REACHABILITY_OPTIONS: Array<{ value: AgentReachabilityPolicy; label: string; detail: string }> = [
  { value: 'server', label: 'Everyone on server', detail: 'Any authenticated user on this host can reach this agent.' },
  { value: 'contacts', label: 'Contacts only', detail: 'Only contacts and shared projects can reach this agent.' },
  { value: 'owner', label: 'Only me', detail: 'Only your own Bridge identity can use this hosted agent directly.' },
];

export function discoveryLabel(value?: string | null) {
  switch ((value ?? '').toLowerCase()) {
    case 'off':
      return 'Hidden';
    case 'contacts':
      return 'Contacts + projects';
    case 'open':
      return 'Visible on this host';
    default:
      return 'Visible on this host';
  }
}

export function humanVisibilityLabel(value?: string | null) {
  const normalized = (value ?? '').toLowerCase();
  return HUMAN_VISIBILITY_OPTIONS.find((option) => option.value === normalized)?.label ?? 'Visible, approval required';
}

export function contactApprovalLabel(value?: string | null) {
  const normalized = (value ?? '').toLowerCase();
  return CONTACT_APPROVAL_OPTIONS.find((option) => option.value === normalized)?.label ?? 'Require approval';
}

export function agentReachabilityLabel(value?: string | null) {
  const normalized = (value ?? '').toLowerCase();
  return AGENT_REACHABILITY_OPTIONS.find((option) => option.value === normalized)?.label ?? 'Contacts only';
}

export function SectionNav({
  activeSection,
  setActiveSection,
  activeBridgeHost,
}: {
  activeSection: BridgePageSection;
  setActiveSection: Dispatch<SetStateAction<BridgePageSection>>;
  activeBridgeHost: DesktopBridgeHost | null;
}) {
  const sections: Array<{ id: BridgePageSection; title: string; detail: string; disabled?: boolean }> = [
    { id: 'servers', title: 'Hosts', detail: 'Add a host or choose where this desktop should collaborate.' },
    { id: 'details', title: 'Identity & contacts', detail: 'Your name, visibility, agents, and direct contacts on the selected host.', disabled: !activeBridgeHost },
    { id: 'advanced', title: 'Files & recovery', detail: 'Local storage, export/import, and Finder tools.' },
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

export function DetailNav({
  activeStep,
  setActiveStep,
  activeBridgeHost,
}: {
  activeStep: BridgeStepId;
  setActiveStep: Dispatch<SetStateAction<BridgeStepId>>;
  activeBridgeHost: DesktopBridgeHost | null;
}) {
  const needsRegistration = !activeBridgeHost?.registered;
  const normalizedActiveStep = activeStep === 'setup'
    ? 'identity'
    : activeStep === 'discover' || activeStep === 'approvals'
      ? 'agents'
      : activeStep;
  const steps: Array<{ id: Exclude<BridgeStepId, 'setup' | 'discover' | 'approvals'>; title: string; detail: string; disabled?: boolean }> = [
    { id: 'identity', title: 'How you appear', detail: 'Your name and share copy on this host.' },
    { id: 'visibility', title: 'Visibility', detail: 'Who can discover you and whether contact requires approval.', disabled: needsRegistration },
    { id: 'agents', title: 'Agent reachability', detail: 'Which agent is active, default, and reachable.', disabled: needsRegistration },
    { id: 'review', title: 'Review', detail: 'Effective strategy and visible peers after setup.', disabled: needsRegistration },
  ];

  return (
    <div className="app-bridge-detail-nav app-bridge-timeline space-y-2">
      {steps.map((step, index) => {
        const active = step.id === normalizedActiveStep;
        const complete = !active && steps.findIndex((candidate) => candidate.id === normalizedActiveStep) > index;
        return (
          <button
            key={step.id}
            type="button"
            disabled={step.disabled}
            onClick={() => setActiveStep(step.id)}
            className={cn(
              'app-bridge-timeline-step flex w-full items-start gap-3 rounded-[18px] border px-3 py-3 text-left transition',
              active ? 'border-white/20 bg-white/[0.08]' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]',
              step.disabled ? 'cursor-not-allowed opacity-45 hover:bg-white/[0.04]' : '',
            )}
          >
            <span className={cn('app-bridge-timeline-dot mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[10px]', active ? 'border-cyan-300/40 bg-cyan-300/15 text-cyan-100' : complete ? 'border-emerald-300/30 bg-emerald-300/12 text-emerald-100' : 'border-white/10 bg-white/[0.04] text-slate-400')}>
              {complete ? '✓' : index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium text-white">{step.title}</span>
              <span className="mt-1 block text-[11px] leading-5 text-slate-400">{step.detail}</span>
            </span>
            <span className="mt-1 shrink-0 text-[10px] uppercase tracking-[0.14em] text-slate-500">{active ? 'Current' : complete ? 'Done' : 'Next'}</span>
          </button>
        );
      })}
    </div>
  );
}

export function DiscoveryModeSelector({
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

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="app-bridge-empty rounded-2xl border border-white/10 bg-[color:var(--app-control-bg)] px-3 py-3 text-[13px] text-slate-400">
      <div className="app-bridge-empty-title">{title}</div>
      <div className="mt-1 text-[12px] leading-5 text-slate-400">{detail}</div>
    </div>
  );
}
