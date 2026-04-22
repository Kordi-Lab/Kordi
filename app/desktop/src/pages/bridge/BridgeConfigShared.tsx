import type { Dispatch, SetStateAction } from 'react';

import { cn } from '@/lib/utils';
import type { DesktopBridgeHost } from '@/kordi-app/types';

import type {
  BridgeConfigPageProps,
  BridgePageSection,
  BridgeStepId,
  DiscoveryMode,
} from './BridgeConfigPage.types';

const DISCOVERY_OPTIONS: Array<{ value: DiscoveryMode; label: string; detail: string }> = [
  { value: 'off', label: 'Hidden', detail: 'Only saved contacts and shared projects can reach you.' },
  { value: 'contacts', label: 'Contacts + projects', detail: 'People you already know, plus shared projects, can find you.' },
  { value: 'open', label: 'Visible on this host', detail: 'Anyone on this host can discover you.' },
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
  const steps: Array<{ id: Exclude<BridgeStepId, 'setup'>; title: string; detail: string; disabled?: boolean }> = [
    { id: 'identity', title: 'How you appear', detail: 'Your name, share copy, and visibility on this host.' },
    { id: 'agents', title: 'My agents', detail: 'Which agent is active and which one is the default.' },
    { id: 'discover', title: 'People & agents', detail: 'Direct contacts, visible people, and visible agents.', disabled: !activeBridgeHost?.registered },
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
