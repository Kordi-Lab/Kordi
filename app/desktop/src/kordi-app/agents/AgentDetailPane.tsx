import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { EditableIdentityAvatar } from '../components/EditableIdentityAvatar';
import { composerThinkingLabel, fallbackComposerThinkingValue, type ComposerModelOption, type ComposerProviderOption } from '../components';
import type { Agent } from '../types';
import { cloudAgentAccessDescription, cloudAgentAccessLabel, formatHistoryPath, getAgentConfigPath, type AgentConfigDraft, type AgentEditHistoryEntry, type AgentSaveFeedback, type PersistedAgentConfig } from './model';
import { promptDisplayText } from './promptDisplay';
import { AgentConfigList, AgentInspectorSection } from './shared';

type DetailTarget = { kind: 'prompt' } | { kind: 'file'; path: string } | null;

type ArchiveAgentFeedback = { tone: 'info' | 'success' | 'error'; text: string };

export async function archiveAgentFromMenu({
  agent,
  onArchiveCloudAgent,
  onFeedback,
}: {
  agent: Agent;
  onArchiveCloudAgent?: (agent: Agent) => Promise<void> | void;
  onFeedback?: (feedback: ArchiveAgentFeedback | null) => void;
}) {
  if (!agent.cloudAgentId || !onArchiveCloudAgent) return false;

  onFeedback?.({ tone: 'info', text: `Deleting ${agent.name}…` });
  try {
    await onArchiveCloudAgent(agent);
    return true;
  } catch (error) {
    onFeedback?.({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to delete agent.' });
    return false;
  }
}

export type RoutingOption = {
  value: string;
  label: string;
  model?: string | null;
  authProvider?: string | null;
  authChoice?: string | null;
  activeAuth?: boolean;
};

type ModelRoutingDraft = {
  agentId: string | null;
  defaultModel: string | null;
  defaultAuthProvider: string | null;
  defaultAuthChoice: string | null;
  fallbackModel: string | null;
  fallbackAuthProvider: string | null;
  fallbackAuthChoice: string | null;
  thinking: string | null;
};

const EMPTY_MODEL_ROUTING_DRAFT: ModelRoutingDraft = {
  agentId: null,
  defaultModel: null,
  defaultAuthProvider: null,
  defaultAuthChoice: null,
  fallbackModel: null,
  fallbackAuthProvider: null,
  fallbackAuthChoice: null,
  thinking: null,
};

export function AgentDeleteConfirmDialog({
  agent,
  isDeleting,
  error,
  onCancel,
  onConfirm,
}: {
  agent: Agent;
  isDeleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AppDialog
      titleId="delete-agent-dialog-title"
      descriptionId="delete-agent-dialog-description"
      onDismiss={onCancel}
      dismissDisabled={isDeleting}
      busy={isDeleting}
      className="max-w-md rounded-[20px]"
      backdropClassName="!z-[100000]"
    >
      <AppDialogTitle id="delete-agent-dialog-title">Delete this agent?</AppDialogTitle>
      <AppDialogDescription id="delete-agent-dialog-description" className="app-transient-muted">
        <span className="block">
          <span className="font-medium text-[color:var(--app-transient-text)]">{agent.name}</span> will be removed from your Agent page and your signed-in cloud devices.
        </span>
        <span className="mt-3 block">It is kept as an archived Cloud record, not hard-deleted forever.</span>
      </AppDialogDescription>
      {error ? (
        <div className="app-error-text mt-4 rounded-[16px] border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100" role="alert">
          {error}
        </div>
      ) : null}
      <AppDialogActions className="mt-5 gap-3">
        <Button variant="secondary" className="rounded-full px-4" autoFocus disabled={isDeleting} onClick={onCancel}>Cancel</Button>
        <Button
          className="rounded-full bg-rose-500 px-4 text-white hover:bg-rose-400"
          disabled={isDeleting}
          onClick={() => { onConfirm(); }}
        >
          {isDeleting ? 'Deleting…' : 'Delete agent'}
        </Button>
      </AppDialogActions>
    </AppDialog>
  );
}

function AgentActionsMenu({ agent, onRequestArchive }: {
  agent: Agent;
  onRequestArchive?: (agent: Agent) => void;
}) {
  if (!agent.cloudAgentId || !onRequestArchive) return null;
  return (
    <details className="relative">
      <summary
        className="app-agent-inspector-row flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-xl border text-slate-300 transition hover:border-white/18 hover:text-white [&::-webkit-details-marker]:hidden"
        aria-label="More agent actions"
        title="More agent actions"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </summary>
      <div className="app-transient-surface absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-[14px] border p-1">
        <button
          type="button"
          className="app-transient-row app-transient-row-danger w-full rounded-[10px] px-3 py-2 text-left text-[12px] font-medium transition"
          onClick={() => {
            onRequestArchive(agent);
          }}
        >
          Delete agent
        </button>
      </div>
    </details>
  );
}

function AgentAccessMenu({ agent, onUpdateAccess, isSaving }: {
  agent: Agent;
  onUpdateAccess?: (agent: Agent, accessScope: 'private' | 'participant_conversations') => Promise<void> | void;
  isSaving?: boolean;
}) {
  if (!agent.cloudAgentId) return null;
  const accessScope = agent.cloudAgentAccessScope === 'participant_conversations' ? 'participant_conversations' : 'private';
  return (
    <div className="app-agent-section border-t pt-5 text-[12px] leading-5">
      <div className="app-agent-row-title font-medium">Access</div>
      <select
        className="mt-2 w-full rounded-[12px] border border-[color:var(--app-divider)] bg-transparent px-3 py-2 text-[12px]"
        value={accessScope}
        onChange={(event) => {
          const next = event.currentTarget.value === 'participant_conversations' ? 'participant_conversations' : 'private';
          void onUpdateAccess?.(agent, next);
        }}
        disabled={!onUpdateAccess || isSaving}
        aria-label="Agent access"
      >
        <option value="private">{cloudAgentAccessLabel('private')}</option>
        <option value="participant_conversations">{cloudAgentAccessLabel('participant_conversations')}</option>
      </select>
      <div className="app-agent-row-meta mt-2">{cloudAgentAccessDescription(accessScope)}</div>
    </div>
  );
}

function EditHistorySection({ entries }: { entries: AgentEditHistoryEntry[] }) {
  return (
    <AgentInspectorSection title="Edit history" detail="Recent saved changes, shown in file path style.">
      <div className="app-agent-inner-list overflow-hidden rounded-[14px] border">
        {entries.length > 0 ? (
          entries.map((entry, index) => (
            <div key={`${entry.path}-${entry.timestamp}-${index}`} className={cn('app-agent-inner-list-row px-3 py-3', index > 0 && 'border-t')}>
              <div className="app-agent-code-label font-mono text-[11px]">{formatHistoryPath(entry.path)}</div>
              <div className="app-agent-row-title mt-1 text-[13px]">{entry.action}</div>
              <div className="app-agent-row-meta mt-1 text-[11px]">{entry.timestamp}</div>
            </div>
          ))
        ) : (
          <div className="app-agent-empty-copy px-3 py-3 text-[13px]">No saved edits yet.</div>
        )}
      </div>
    </AgentInspectorSection>
  );
}

function truncatePrompt(value: string) {
  const normalized = promptDisplayText(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return 'No real prompt payload is exposed for this identity.';
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 179).trimEnd()}…`;
}

function compactRoutingValue(value?: string | null) {
  return value?.trim() || null;
}

function modelRoutingDraftFromAgent(agent?: Agent | null): ModelRoutingDraft {
  if (!agent) return EMPTY_MODEL_ROUTING_DRAFT;
  return {
    agentId: agent.id,
    defaultModel: compactRoutingValue(agent.defaultModel),
    defaultAuthProvider: compactRoutingValue(agent.defaultAuthProvider),
    defaultAuthChoice: compactRoutingValue(agent.defaultAuthChoice),
    fallbackModel: compactRoutingValue(agent.fallbackModel),
    fallbackAuthProvider: compactRoutingValue(agent.fallbackAuthProvider),
    fallbackAuthChoice: compactRoutingValue(agent.fallbackAuthChoice),
    thinking: compactRoutingValue(agent.defaultThinking),
  };
}

function routingDraftKey(draft: ModelRoutingDraft) {
  return [
    draft.agentId,
    draft.defaultModel,
    draft.defaultAuthProvider,
    draft.defaultAuthChoice,
    draft.fallbackModel,
    draft.fallbackAuthProvider,
    draft.fallbackAuthChoice,
    draft.thinking,
  ].map((value) => value ?? '').join('\u0000');
}

function sameRoutingDraft(left: ModelRoutingDraft, right: ModelRoutingDraft) {
  return routingDraftKey(left) === routingDraftKey(right);
}

export function AgentRoutingSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: RoutingOption[];
  onChange: (option: RoutingOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const valueId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const selectedLabel = selected?.label ?? 'Select';

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    queueMicrotask(() => {
      const selectedOption = listboxRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
      const firstOption = listboxRef.current?.querySelector<HTMLElement>('[role="option"]');
      (selectedOption ?? firstOption)?.focus();
    });
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      queueMicrotask(() => triggerRef.current?.focus());
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  const handleListboxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const optionElements = Array.from(listboxRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    if (optionElements.length === 0) return;
    event.preventDefault();
    const activeIndex = optionElements.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? optionElements.length - 1
        : event.key === 'ArrowUp'
          ? (activeIndex <= 0 ? optionElements.length - 1 : activeIndex - 1)
          : (activeIndex + 1) % optionElements.length;
    optionElements[nextIndex]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="relative min-w-0"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) return;
        setOpen(false);
      }}
    >
      <div id={labelId} className="app-agent-row-meta mb-1 text-[11px]">{label}</div>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => setOpen((current) => !current)}
        title={selectedLabel}
        className="app-agent-inspector-row flex min-h-10 w-full items-center justify-between gap-2 rounded-[12px] border px-3 py-2.5 text-left text-[12px] transition hover:border-white/18"
      >
        <span id={valueId} className="app-agent-row-title min-w-0 flex-1 whitespace-normal break-words leading-5">{selectedLabel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', open ? 'rotate-180 text-slate-300' : '')} />
      </button>
      {open ? (
        <div
          ref={listboxRef}
          role="listbox"
          aria-labelledby={labelId}
          onKeyDown={handleListboxKeyDown}
          className="app-transient-surface app-transient-scroll absolute left-0 top-full z-40 mt-2 max-h-[min(20rem,45vh)] w-full min-w-[min(22rem,calc(100vw-3rem))] max-w-[min(34rem,calc(100vw-3rem))] overflow-y-auto rounded-[16px] border px-3 py-3 text-[12px]"
        >
          <div className="space-y-1">
            {options.map((option) => {
              const selectedOption = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selectedOption}
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                    queueMicrotask(() => triggerRef.current?.focus());
                  }}
                  title={option.label}
                  className={cn(
                    'app-composer-popover-item flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left text-[13px]',
                    selectedOption ? 'app-composer-popover-item-active' : '',
                  )}
                >
                  <span className="min-w-0 flex-1 whitespace-normal break-words leading-5">{option.label}</span>
                  <span className={cn('shrink-0 text-[11px] font-medium', selectedOption ? 'text-[color:var(--utility-foreground)]' : 'text-transparent')}>
                    Selected
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function modelOptionLabel(option: ComposerModelOption) {
  const provider = option.providerLabel || option.provider;
  return provider ? `${option.label} · ${provider}` : option.label;
}

function normalizeRoutingProviderId(value?: string | null) {
  const normalized = value?.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!normalized) return '';
  if (['openai-codex', 'openai-api', 'openai-api-key', 'chatgpt', 'chatgpt-account'].includes(normalized)) return 'openai';
  if (['claude', 'claude-subscription', 'anthropic-api', 'anthropic-api-key'].includes(normalized)) return 'anthropic';
  return normalized;
}

function modelIdFromOption(option: ComposerModelOption) {
  const provider = option.provider?.trim();
  if (provider && option.value.startsWith(`${provider}/`)) {
    return option.value.slice(provider.length + 1);
  }
  const [, ...modelParts] = option.value.split('/');
  return modelParts.join('/') || option.value;
}

function modelValueMatchesOption(option: ComposerModelOption, modelValue: string) {
  const compact = modelValue.trim();
  return option.value === compact || option.label === compact || modelIdFromOption(option) === compact;
}

function resolveRoutingModelValue(modelValue: string | null | undefined, providerHint: string | null | undefined, modelOptions: ComposerModelOption[]) {
  const compact = compactRoutingValue(modelValue);
  if (!compact) return null;
  if (modelOptions.some((option) => option.value === compact)) return compact;

  const matches = modelOptions.filter((option) => modelValueMatchesOption(option, compact));
  const normalizedProviderHint = normalizeRoutingProviderId(providerHint);
  const providerMatches = normalizedProviderHint
    ? matches.filter((option) => normalizeRoutingProviderId(option.provider ?? option.value.split('/')[0]) === normalizedProviderHint)
    : [];

  if (providerMatches.length === 1) return providerMatches[0]?.value ?? compact;
  if (matches.length === 1) return matches[0]?.value ?? compact;
  return compact;
}

function authChoiceFromProviderOption(option: ComposerProviderOption) {
  return option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;
}

function routingAuthOptions(providerOptions?: ComposerProviderOption[]) {
  return (providerOptions ?? []).map((option) => ({
    providerId: option.providerId,
    normalizedProviderId: normalizeRoutingProviderId(option.providerId),
    authChoice: authChoiceFromProviderOption(option),
    label: option.label,
    detail: option.detail?.trim() || option.selectionLabel?.trim() || null,
    active: Boolean(option.active),
  }));
}

function routeKey(model?: string | null, authProvider?: string | null, authChoice?: string | null) {
  return [model?.trim() ?? '', authProvider?.trim() ?? '', authChoice?.trim() ?? ''].join('::');
}

function routeLabel(model: ComposerModelOption, auth?: ReturnType<typeof routingAuthOptions>[number]) {
  if (!auth) return modelOptionLabel(model);
  return [auth.label, auth.detail, model.label].filter(Boolean).join(' · ');
}

function buildRouteOptions({
  models,
  authOptions,
  currentModel,
  currentAuthProvider,
  currentAuthChoice,
  includeNoFallback,
}: {
  models: ComposerModelOption[];
  authOptions: ReturnType<typeof routingAuthOptions>;
  currentModel?: string | null;
  currentAuthProvider?: string | null;
  currentAuthChoice?: string | null;
  includeNoFallback?: boolean;
}) {
  const options: RoutingOption[] = includeNoFallback
    ? [{ value: routeKey('', '', ''), label: 'No fallback', model: null, authProvider: null, authChoice: null }]
    : [];

  for (const model of models) {
    const provider = normalizeRoutingProviderId(model.provider ?? model.value.split('/')[0]);
    const matchingAuth = authOptions.filter((auth) => auth.normalizedProviderId === provider);
    if (matchingAuth.length === 0) {
      options.push({
        value: routeKey(model.value, null, null),
        label: modelOptionLabel(model),
        model: model.value,
        authProvider: null,
        authChoice: null,
      });
      continue;
    }

    for (const auth of matchingAuth) {
      options.push({
        value: routeKey(model.value, auth.providerId, auth.authChoice),
        label: routeLabel(model, auth),
        model: model.value,
        authProvider: auth.providerId,
        authChoice: auth.authChoice,
        activeAuth: auth.active,
      });
    }
  }

  if (currentModel?.trim()) {
    const currentKey = routeKey(currentModel, currentAuthProvider, currentAuthChoice);
    const hasKnownModelRoute = options.some((option) => option.model === currentModel);
    if (!hasKnownModelRoute && !options.some((option) => option.value === currentKey)) {
      options.push({
        value: currentKey,
        label: currentModel,
        model: currentModel,
        authProvider: currentAuthProvider ?? null,
        authChoice: currentAuthChoice ?? null,
      });
    }
  }

  return uniqueRoutingOptions(options);
}

function selectedRouteValue(options: RoutingOption[], model?: string | null, authProvider?: string | null, authChoice?: string | null) {
  const exact = routeKey(model, authProvider, authChoice);
  if (options.some((option) => option.value === exact)) return exact;
  const normalizedAuthProvider = normalizeRoutingProviderId(authProvider);
  return options.find((option) => (
    option.model === model
      && option.authChoice === authChoice
      && normalizeRoutingProviderId(option.authProvider) === normalizedAuthProvider
  ))?.value
    ?? options.find((option) => option.model === model && option.activeAuth)?.value
    ?? options.find((option) => option.model === model)?.value
    ?? exact;
}

function uniqueRoutingOptions(options: RoutingOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function InspectorRow({
  label,
  detail,
  active,
  onClick,
  trailing,
}: {
  label: string;
  detail: string;
  active?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}) {
  const content = (
    <div
      className={cn(
        'app-agent-inspector-row rounded-[14px] border px-3 py-3 text-left transition',
        active ? 'app-agent-inspector-row-active' : '',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="app-agent-row-title text-[12px] font-medium">{label}</div>
          <div className="app-agent-row-copy mt-1 text-[12px] leading-5">{detail}</div>
        </div>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
    </div>
  );

  if (!onClick) return content;
  return (
    <button type="button" className="block w-full" onClick={onClick}>
      {content}
    </button>
  );
}

export function AgentDetailPane({
  activeAgent,
  activeAgentConfig,
  activePersistedConfig,
  activeDetail,
  activeSaveFeedback,
  activeEditingSection,
  availableSkills,
  chatModelOptions,
  composerProviderOptions,
  onUpdateModelRouting,
  onReset,
  onMessage,
  onOpenReachoutSession,
  onUpdateCloudAgent,
  onArchiveCloudAgent,
  onOpenPromptDetail,
  onStartEditing,
  onSave,
  onCancelEditing,
  onToggleSkill,
  onSelectIdentityFile,
}: {
  activeAgent?: Agent;
  activeAgentConfig: AgentConfigDraft | null;
  activePersistedConfig: PersistedAgentConfig | null;
  activeDetail: DetailTarget;
  activeSaveFeedback: AgentSaveFeedback | null;
  activeEditingSection: 'prompt' | 'skills' | null;
  availableSkills: string[];
  chatModelOptions?: ComposerModelOption[];
  composerProviderOptions?: ComposerProviderOption[];
  onUpdateModelRouting?: (
    agent: Agent,
    values: {
      defaultModel?: string | null;
      defaultAuthProvider?: string | null;
      defaultAuthChoice?: string | null;
      fallbackModel?: string | null;
      fallbackAuthProvider?: string | null;
      fallbackAuthChoice?: string | null;
      thinking?: string | null;
    },
  ) => Promise<void> | void;
  onReset: (agent: Agent) => void;
  onMessage?: () => void;
  onOpenReachoutSession?: (sessionId: string) => void;
  onUpdateCloudAgent?: (agent: Agent, input: { accessScope: 'private' | 'participant_conversations' }) => Promise<Agent> | Promise<void> | Agent | void;
  onArchiveCloudAgent?: (agent: Agent) => Promise<void> | void;
  onOpenPromptDetail: (agentId: string) => void;
  onStartEditing: (agentId: string, section: 'prompt' | 'skills') => void;
  onSave: (agent: Agent, section: 'prompt' | 'skills') => void;
  onCancelEditing: (agent: Agent) => void;
  onToggleSkill: (agentId: string, skill: string, selected: boolean) => void;
  onSelectIdentityFile: (agentId: string, file: string) => void;
}) {
  const persistedRoutingDraft = useMemo(() => modelRoutingDraftFromAgent(activeAgent), [
    activeAgent?.id,
    activeAgent?.defaultModel,
    activeAgent?.defaultAuthProvider,
    activeAgent?.defaultAuthChoice,
    activeAgent?.fallbackModel,
    activeAgent?.fallbackAuthProvider,
    activeAgent?.fallbackAuthChoice,
    activeAgent?.defaultThinking,
  ]);
  const persistedRoutingKey = routingDraftKey(persistedRoutingDraft);
  const [routingDraft, setRoutingDraft] = useState<ModelRoutingDraft>(persistedRoutingDraft);
  const [isRoutingSaving, setIsRoutingSaving] = useState(false);
  const [routingSaveFeedback, setRoutingSaveFeedback] = useState<{ tone: 'idle' | 'success' | 'error'; text: string } | null>(null);
  const [archiveFeedback, setArchiveFeedback] = useState<ArchiveAgentFeedback | null>(null);
  const [archiveConfirmAgent, setArchiveConfirmAgent] = useState<Agent | null>(null);
  const [isArchiveDeleting, setIsArchiveDeleting] = useState(false);
  const [archiveDeleteError, setArchiveDeleteError] = useState<string | null>(null);
  const [isAccessSaving, setIsAccessSaving] = useState(false);

  useEffect(() => {
    setRoutingDraft(persistedRoutingDraft);
    setIsRoutingSaving(false);
    setRoutingSaveFeedback(null);
    setArchiveFeedback(null);
    setArchiveConfirmAgent(null);
    setIsArchiveDeleting(false);
    setArchiveDeleteError(null);
  }, [persistedRoutingDraft, persistedRoutingKey]);

  if (!activeAgent || !activeAgentConfig) {
    return (
      <section className="app-agent-detail-pane flex min-h-0 min-w-0 flex-col">
        <div className="app-agent-empty-state flex h-full items-center justify-center px-6 text-center text-[13px] leading-5">
          Select an agent to inspect its system prompt, tools, plugins, skills, and identity files.
        </div>
      </section>
    );
  }

  const activeConfigPath = getAgentConfigPath(activeAgent);
  const isEditable = Boolean(activeConfigPath);
  const hasRuntimePrompt = activeAgentConfig.systemPrompt.trim().length > 0;
  const exposesIdentityFiles = activeAgent.exposesIdentityFiles !== false;
  const exposesLoadedSkills = activeAgent.exposesLoadedSkills !== false;
  const exposesLoadedTools = activeAgent.exposesLoadedTools !== false;
  const exposesLoadedPlugins = activeAgent.exposesLoadedPlugins !== false;
  const selectedFilePath = activeDetail?.kind === 'file' ? activeDetail.path : null;
  const activeRoutingDraft = routingDraft.agentId === activeAgent.id ? routingDraft : persistedRoutingDraft;
  const canEditModelRouting = Boolean(activeAgent.isOwned && onUpdateModelRouting);
  const routingPersistsToBridge = Boolean(activeAgent.bridgeHostId && activeAgent.bridgeAgentId);
  const routeModelOptions = chatModelOptions ?? [];
  const resolvedDefaultModel = resolveRoutingModelValue(
    activeRoutingDraft.defaultModel,
    activeRoutingDraft.defaultAuthProvider ?? activeAgent.defaultProvider,
    routeModelOptions,
  );
  const resolvedFallbackModel = resolveRoutingModelValue(
    activeRoutingDraft.fallbackModel,
    activeRoutingDraft.fallbackAuthProvider,
    routeModelOptions,
  );
  const updateRoutingDraft = (patch: Partial<ModelRoutingDraft>) => {
    if (!canEditModelRouting) return;
    setRoutingDraft((current) => ({
      ...(current.agentId === activeAgent.id ? current : activeRoutingDraft),
      ...patch,
      agentId: activeAgent.id,
    }));
    setRoutingSaveFeedback(null);
  };
  const saveRoutingDraft = () => {
    if (!canEditModelRouting || !routingSaveDirty || isRoutingSaving) return;
    setIsRoutingSaving(true);
    setRoutingSaveFeedback(null);
    void Promise.resolve(onUpdateModelRouting?.(activeAgent, {
      defaultModel: effectiveRoutingDraft.defaultModel,
      defaultAuthProvider: effectiveRoutingDraft.defaultAuthProvider,
      defaultAuthChoice: effectiveRoutingDraft.defaultAuthChoice,
      fallbackModel: effectiveRoutingDraft.fallbackModel,
      fallbackAuthProvider: effectiveRoutingDraft.fallbackAuthProvider,
      fallbackAuthChoice: effectiveRoutingDraft.fallbackAuthChoice,
      thinking: effectiveRoutingDraft.thinking,
    }))
      .then(() => {
        setRoutingSaveFeedback({ tone: 'success', text: 'Routing saved.' });
      })
      .catch((error) => {
        setRoutingSaveFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to save routing.' });
      })
      .finally(() => {
        setIsRoutingSaving(false);
      });
  };
  const resetRoutingDraft = () => {
    setRoutingDraft(persistedRoutingDraft);
    setRoutingSaveFeedback(null);
  };
  const authOptions = routingAuthOptions(composerProviderOptions);
  const modelOptions = buildRouteOptions({
    models: routeModelOptions,
    authOptions,
    currentModel: resolvedDefaultModel,
    currentAuthProvider: activeRoutingDraft.defaultAuthProvider,
    currentAuthChoice: activeRoutingDraft.defaultAuthChoice,
  });
  const fallbackOptions = buildRouteOptions({
    models: routeModelOptions,
    authOptions,
    currentModel: resolvedFallbackModel,
    currentAuthProvider: activeRoutingDraft.fallbackAuthProvider,
    currentAuthChoice: activeRoutingDraft.fallbackAuthChoice,
    includeNoFallback: true,
  });
  const selectedDefaultRouteValue = selectedRouteValue(
    modelOptions,
    resolvedDefaultModel,
    activeRoutingDraft.defaultAuthProvider,
    activeRoutingDraft.defaultAuthChoice,
  );
  const selectedFallbackRouteValue = resolvedFallbackModel
    ? selectedRouteValue(
        fallbackOptions,
        resolvedFallbackModel,
        activeRoutingDraft.fallbackAuthProvider,
        activeRoutingDraft.fallbackAuthChoice,
      )
    : routeKey('', '', '');
  const selectedDefaultRoute = modelOptions.find((option) => option.value === selectedDefaultRouteValue) ?? null;
  const selectedFallbackRoute = fallbackOptions.find((option) => option.value === selectedFallbackRouteValue) ?? null;
  const selectedModelOption = routeModelOptions.find((option) => option.value === resolvedDefaultModel);
  const selectedThinkingLevels = selectedModelOption?.thinkingLevels?.length ? selectedModelOption.thinkingLevels : ['off', 'medium', 'high'];
  const thinkingOptions = uniqueRoutingOptions([
    { value: '', label: 'Model default' },
    ...(selectedThinkingLevels.map((level) => ({ value: level, label: composerThinkingLabel(level) }))),
  ]);
  const selectedThinkingValue = activeRoutingDraft.thinking
    ? fallbackComposerThinkingValue(selectedThinkingLevels, activeRoutingDraft.thinking)
    : '';
  const effectiveRoutingDraft: ModelRoutingDraft = {
    ...activeRoutingDraft,
    defaultModel: selectedDefaultRoute?.model ?? resolvedDefaultModel,
    defaultAuthProvider: selectedDefaultRoute?.model ? (selectedDefaultRoute.authProvider ?? null) : (activeRoutingDraft.defaultAuthProvider ?? null),
    defaultAuthChoice: selectedDefaultRoute?.model ? (selectedDefaultRoute.authChoice ?? null) : (activeRoutingDraft.defaultAuthChoice ?? null),
    fallbackModel: resolvedFallbackModel ? (selectedFallbackRoute?.model ?? resolvedFallbackModel) : null,
    fallbackAuthProvider: resolvedFallbackModel ? (selectedFallbackRoute?.model ? (selectedFallbackRoute.authProvider ?? null) : (activeRoutingDraft.fallbackAuthProvider ?? null)) : null,
    fallbackAuthChoice: resolvedFallbackModel ? (selectedFallbackRoute?.model ? (selectedFallbackRoute.authChoice ?? null) : (activeRoutingDraft.fallbackAuthChoice ?? null)) : null,
    thinking: selectedThinkingValue || null,
  };
  const routingDraftDirty = !sameRoutingDraft(activeRoutingDraft, persistedRoutingDraft);
  const routingSaveDirty = !sameRoutingDraft(effectiveRoutingDraft, persistedRoutingDraft);
  const routingIdleCopy = routingPersistsToBridge
    ? 'Select routes instantly; saved routes run this Bridge agent.'
    : 'Saved locally until this agent is connected to Bridge; connected Bridge agents inherit it.';
  const confirmArchiveAgent = () => {
    if (!archiveConfirmAgent || isArchiveDeleting) return;
    setIsArchiveDeleting(true);
    setArchiveDeleteError(null);
    void archiveAgentFromMenu({
      agent: archiveConfirmAgent,
      onArchiveCloudAgent,
      onFeedback: setArchiveFeedback,
    })
      .then((archived) => {
        if (archived) {
          setArchiveConfirmAgent(null);
        } else {
          setArchiveDeleteError('Unable to delete agent. Please try again.');
        }
      })
      .finally(() => {
        setIsArchiveDeleting(false);
      });
  };

  const updateCloudAgentAccess = async (agent: Agent, accessScope: 'private' | 'participant_conversations') => {
    if (!onUpdateCloudAgent || isAccessSaving || agent.cloudAgentAccessScope === accessScope) return;
    setIsAccessSaving(true);
    setArchiveFeedback({ tone: 'info', text: `Updating access for ${agent.name}…` });
    try {
      await onUpdateCloudAgent(agent, { accessScope });
      setArchiveFeedback({ tone: 'success', text: `${agent.name} is now ${cloudAgentAccessLabel(accessScope).toLowerCase()}.` });
    } catch (error) {
      setArchiveFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to update agent access.' });
    } finally {
      setIsAccessSaving(false);
    }
  };
  const modelRoutingSection = activeAgent.isOwned ? (
    <AgentInspectorSection title="Model routing" detail="Backbone/default auth source + model, fallback auth source + model, and thinking for this owned agent. These choices are private and not announced in shared chat history.">
      <div className="app-agent-section-detail text-[13px] leading-5">
        {routingPersistsToBridge
          ? 'Use the default model for inbound mentions and reach-outs. If it is unavailable or errors during generation, Kordi retries with the fallback model.'
          : 'Choose the default and fallback now. Saved locally until this agent is connected to Bridge, then the connected Bridge agent inherits the same routing.'}
      </div>
      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-3">
        <AgentRoutingSelect
          label="Default route"
          value={selectedDefaultRouteValue}
          options={modelOptions}
          onChange={(option) => {
            updateRoutingDraft({
              defaultModel: option.model || null,
              defaultAuthProvider: option.authProvider ?? null,
              defaultAuthChoice: option.authChoice ?? null,
            });
          }}
        />
        <AgentRoutingSelect
          label="Fallback route"
          value={selectedFallbackRouteValue}
          options={fallbackOptions}
          onChange={(option) => {
            updateRoutingDraft({
              fallbackModel: option.model || null,
              fallbackAuthProvider: option.model ? (option.authProvider ?? null) : null,
              fallbackAuthChoice: option.model ? (option.authChoice ?? null) : null,
            });
          }}
        />
        <AgentRoutingSelect
          label="Thinking level"
          value={selectedThinkingValue}
          options={thinkingOptions}
          onChange={(option) => {
            updateRoutingDraft({ thinking: option.value || null });
          }}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div
          className={cn(
            'text-[12px] leading-5',
            routingSaveFeedback?.tone === 'error'
              ? 'text-rose-300'
              : routingSaveDirty
                ? 'text-amber-200'
                : routingSaveFeedback?.tone === 'success'
                  ? 'text-emerald-300'
                  : 'app-agent-row-meta',
          )}
        >
          {routingSaveFeedback?.text ?? (routingSaveDirty ? 'Unsaved route changes. Save when ready.' : routingIdleCopy)}
        </div>
        <div className="flex items-center gap-2">
          {routingDraftDirty ? (
            <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={resetRoutingDraft} disabled={isRoutingSaving}>
              Discard
            </Button>
          ) : null}
          <Button className="h-8 rounded-[10px] px-3 text-[12px]" onClick={saveRoutingDraft} disabled={!canEditModelRouting || !routingSaveDirty || isRoutingSaving}>
            {isRoutingSaving ? 'Saving…' : 'Save routing'}
          </Button>
        </div>
      </div>
    </AgentInspectorSection>
  ) : null;

  return (
    <section className="app-agent-detail-pane flex min-h-0 min-w-0 flex-col">
      <div className="app-agent-panel-header px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <EditableIdentityAvatar
              kind="agent"
              seed={activeAgent.avatarSeed ?? activeAgent.id}
              name={activeAgent.name}
              imageUrl={activeAgent.profileImageUrl}
              label={`${activeAgent.name} avatar`}
              compact
              className="mt-0.5 h-12 w-12 border border-white/10"
            />
            <div className="min-w-0">
              <div className="app-agent-panel-subtitle text-[12px] font-medium">Agent inspector</div>
              <div className="app-agent-hero-title mt-1 truncate text-[22px] font-semibold tracking-[-0.02em]">{activeAgent.name}</div>
              <div className="app-agent-panel-subtitle mt-1 text-[13px]">Middle panel lists each item. Click prompt or markdown files to open detail on the right.</div>
            {archiveFeedback || activeSaveFeedback ? (
              <div
                className={cn(
                  'mt-2 text-[12px]',
                  (archiveFeedback?.tone ?? activeSaveFeedback?.tone) === 'success'
                    ? 'text-emerald-300'
                    : (archiveFeedback?.tone ?? activeSaveFeedback?.tone) === 'error'
                      ? 'text-rose-300'
                      : 'text-slate-400',
                )}
              >
                {archiveFeedback?.text ?? activeSaveFeedback?.text}
              </div>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AgentActionsMenu
              agent={activeAgent}
              onRequestArchive={onArchiveCloudAgent ? (agent) => {
                setArchiveFeedback(null);
                setArchiveDeleteError(null);
                setArchiveConfirmAgent(agent);
              } : undefined}
            />
            {isEditable ? (
              <Button variant="secondary" className="rounded-xl text-[12px]" onClick={() => onReset(activeAgent)}>
                Reset
              </Button>
            ) : null}
            <Button
              className="rounded-xl text-[12px]"
              onClick={() => onMessage?.()}
              disabled={!onMessage || (!activeAgent.cloudAgentId && (!activeAgent.bridgeHostId || !activeAgent.bridgePeerNodeId))}
            >
              Message
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 px-5 py-5">
          {archiveConfirmAgent ? (
            <AgentDeleteConfirmDialog
              agent={archiveConfirmAgent}
              isDeleting={isArchiveDeleting}
              error={archiveDeleteError}
              onCancel={() => {
                if (isArchiveDeleting) return;
                setArchiveConfirmAgent(null);
                setArchiveDeleteError(null);
              }}
              onConfirm={confirmArchiveAgent}
            />
          ) : null}

          <AgentAccessMenu
            agent={activeAgent}
            onUpdateAccess={onUpdateCloudAgent ? updateCloudAgentAccess : undefined}
            isSaving={isAccessSaving}
          />

          {modelRoutingSection}

          {(activeAgent.bridgeReachouts?.length ?? 0) > 0 ? (
            <AgentInspectorSection title="Direct reachouts" detail="People contacting this agent directly appear here instead of in your person chats.">
              <div className="app-agent-inner-list overflow-hidden rounded-[14px] border">
                {activeAgent.bridgeReachouts?.map((reachout, index) => (
                  <button
                    key={reachout.sessionId}
                    type="button"
                    className={cn('app-agent-inner-list-row block w-full px-3 py-3 text-left', index > 0 && 'border-t')}
                    onClick={() => onOpenReachoutSession?.(reachout.sessionId)}
                    disabled={!onOpenReachoutSession}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="app-agent-row-title truncate text-[13px] font-medium">{reachout.title}</div>
                        <div className="app-agent-row-meta mt-1 truncate text-[12px]">{reachout.preview || 'No messages yet'}</div>
                      </div>
                      <div className="app-agent-row-meta shrink-0 text-[11px]">{reachout.updatedAtLabel ?? ''}</div>
                    </div>
                  </button>
                ))}
              </div>
            </AgentInspectorSection>
          ) : null}

          <AgentInspectorSection title="Overview" detail="System prompt and markdown/config files open in the right panel.">
            <div className="space-y-3">
              <InspectorRow
                label={hasRuntimePrompt ? 'System prompt' : 'System prompt unavailable'}
                detail={truncatePrompt(activeAgentConfig.systemPrompt)}
                active={activeDetail?.kind === 'prompt'}
                onClick={() => onOpenPromptDetail(activeAgent.id)}
                trailing={<div className="app-agent-row-meta text-[11px]">{activeConfigPath ?? 'runtime'}</div>}
              />

              {exposesIdentityFiles ? (
                activeAgent.identityFiles.map((file) => (
                  <InspectorRow
                    key={file}
                    label={file.split('/').pop() ?? file}
                    detail={file}
                    active={selectedFilePath === file}
                    onClick={() => onSelectIdentityFile(activeAgent.id, file)}
                    trailing={<div className="app-agent-row-meta text-[11px]">Open</div>}
                  />
                ))
              ) : (
                <div className="app-agent-empty-callout text-[13px]">
                  No real identity files are exposed for this bridge agent.
                </div>
              )}
            </div>
          </AgentInspectorSection>

          <AgentInspectorSection title="Loaded skills" detail="Show and edit the skill list here without opening a full detail pane.">
            {exposesLoadedSkills ? (
              <>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="app-agent-row-meta text-[11px]">Persisted in {activeConfigPath ?? (hasRuntimePrompt ? 'current runtime' : 'not exposed by bridge agent')}</div>
                  {isEditable ? (
                    activeEditingSection === 'skills' ? (
                      <div className="flex items-center gap-2">
                        <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onCancelEditing(activeAgent)}>
                          Cancel
                        </Button>
                        <Button className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onSave(activeAgent, 'skills')}>
                          Save
                        </Button>
                      </div>
                    ) : (
                      <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onStartEditing(activeAgent.id, 'skills')}>
                        Edit
                      </Button>
                    )
                  ) : (
                    <div className="app-agent-row-meta text-[11px]">Runtime-managed</div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {availableSkills.map((skill) => {
                    const selected = activeAgentConfig.loadedSkills.includes(skill);
                    return (
                      <button
                        key={skill}
                        type="button"
                        disabled={!isEditable || activeEditingSection !== 'skills'}
                        onClick={() => onToggleSkill(activeAgent.id, skill, selected)}
                        className={cn(
                          'app-agent-skill-chip rounded-full border px-3 py-1.5 text-[12px] transition',
                          selected ? 'app-agent-skill-chip-selected' : '',
                          isEditable && activeEditingSection === 'skills' ? 'app-agent-skill-chip-editable' : 'cursor-default opacity-80',
                        )}
                      >
                        {skill}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="app-agent-empty-callout text-[13px]">
                No real loaded-skills payload is exposed for this bridge agent.
              </div>
            )}
          </AgentInspectorSection>

          <div className="app-agent-support-grid grid gap-5">
            <AgentInspectorSection title="Loaded tools">
              {exposesLoadedTools ? (
                <AgentConfigList items={activePersistedConfig?.loadedTools ?? activeAgent.loadedTools} emptyLabel="No tools loaded for this identity." />
              ) : (
                <div className="app-agent-empty-callout text-[13px]">
                  No real loaded-tools payload is exposed for this bridge agent.
                </div>
              )}
            </AgentInspectorSection>

            <AgentInspectorSection title="Loaded plugins">
              {exposesLoadedPlugins ? (
                <AgentConfigList items={activePersistedConfig?.loadedPlugins ?? activeAgent.loadedPlugins} emptyLabel="No plugins loaded for this identity." />
              ) : (
                <div className="app-agent-empty-callout text-[13px]">
                  No real loaded-plugins payload is exposed for this bridge agent.
                </div>
              )}
            </AgentInspectorSection>
          </div>

          <EditHistorySection entries={activePersistedConfig?.editHistory ?? []} />

          <AgentInspectorSection title="Recent activity">
            <div className="app-agent-inner-list overflow-hidden rounded-[14px] border">
              {activeAgent.lastActivities.map((activity, index) => (
                <div key={activity} className={cn('app-agent-inner-list-row app-agent-row-title px-3 py-2.5 text-[13px]', index > 0 && 'border-t')}>
                  {activity}
                </div>
              ))}
            </div>
          </AgentInspectorSection>
        </div>
      </ScrollArea>
    </section>
  );
}
