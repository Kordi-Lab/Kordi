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
  { value: 'off', label: 'Off', detail: 'Do not appear in open host discovery.' },
  { value: 'contacts', label: 'Contacts only', detail: 'Only contacts and shared projects can see you.' },
  { value: 'open', label: 'Open on this host', detail: 'Let people on this host discover you.' },
];

export function discoveryLabel(value?: string | null) {
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
    <div className="app-bridge-empty rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-[13px] text-slate-400">
      <div className="app-bridge-empty-title">{title}</div>
      <div className="mt-1 text-[12px] leading-5 text-slate-400">{detail}</div>
    </div>
  );
}
