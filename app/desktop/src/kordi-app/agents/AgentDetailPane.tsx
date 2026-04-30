import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { EditableIdentityAvatar } from '../components/EditableIdentityAvatar';
import type { ComposerModelOption, ComposerProviderOption } from '../components';
import type { Agent } from '../types';
import { formatHistoryPath, getAgentConfigPath, type AgentConfigDraft, type AgentEditHistoryEntry, type AgentSaveFeedback, type PersistedAgentConfig } from './model';
import { AgentConfigList, AgentInspectorSection } from './shared';

type DetailTarget = { kind: 'prompt' } | { kind: 'file'; path: string } | null;

type RoutingOption = {
  value: string;
  label: string;
  model?: string | null;
  authProvider?: string | null;
  authChoice?: string | null;
  activeAuth?: boolean;
};

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
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'No real prompt payload is exposed for this identity.';
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 179).trimEnd()}…`;
}

function RoutingSelect({
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
  const selected = options.find((option) => option.value === value) ?? options[0];
  const selectedLabel = selected?.label ?? 'Select';

  return (
    <div className="relative min-w-0">
      <div className="app-agent-row-meta mb-1 text-[11px]">{label}</div>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title={selectedLabel}
        className="app-agent-inspector-row flex min-h-10 w-full items-center justify-between gap-2 rounded-[12px] border px-3 py-2.5 text-left text-[12px] transition hover:border-white/18"
      >
        <span className="app-agent-row-title min-w-0 flex-1 whitespace-normal break-words leading-5">{selectedLabel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', open ? 'rotate-180 text-slate-300' : '')} />
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute left-0 top-full z-40 mt-2 max-h-[min(20rem,45vh)] w-full min-w-[min(22rem,calc(100vw-3rem))] max-w-[min(34rem,calc(100vw-3rem))] overflow-y-auto rounded-[14px] border border-[color:var(--app-divider)] bg-[var(--app-modal-bg)] px-3 py-3 text-[12px] text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)] backdrop-blur-xl"
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
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return '';
  return normalized === 'openai-codex' ? 'openai' : normalized;
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
    if (!options.some((option) => option.value === currentKey)) {
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
  onOpenPromptDetail: (agentId: string) => void;
  onStartEditing: (agentId: string, section: 'prompt' | 'skills') => void;
  onSave: (agent: Agent, section: 'prompt' | 'skills') => void;
  onCancelEditing: (agent: Agent) => void;
  onToggleSkill: (agentId: string, skill: string, selected: boolean) => void;
  onSelectIdentityFile: (agentId: string, file: string) => void;
}) {
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
  const canEditModelRouting = Boolean(activeAgent.isOwned && activeAgent.bridgeHostId && activeAgent.bridgeAgentId && onUpdateModelRouting);
  const authOptions = routingAuthOptions(composerProviderOptions);
  const modelOptions = buildRouteOptions({
    models: chatModelOptions ?? [],
    authOptions,
    currentModel: activeAgent.defaultModel,
    currentAuthProvider: activeAgent.defaultAuthProvider,
    currentAuthChoice: activeAgent.defaultAuthChoice,
  });
  const fallbackOptions = buildRouteOptions({
    models: chatModelOptions ?? [],
    authOptions,
    currentModel: activeAgent.fallbackModel,
    currentAuthProvider: activeAgent.fallbackAuthProvider,
    currentAuthChoice: activeAgent.fallbackAuthChoice,
    includeNoFallback: true,
  });
  const selectedDefaultRouteValue = selectedRouteValue(
    modelOptions,
    activeAgent.defaultModel,
    activeAgent.defaultAuthProvider,
    activeAgent.defaultAuthChoice,
  );
  const selectedFallbackRouteValue = activeAgent.fallbackModel
    ? selectedRouteValue(
        fallbackOptions,
        activeAgent.fallbackModel,
        activeAgent.fallbackAuthProvider,
        activeAgent.fallbackAuthChoice,
      )
    : routeKey('', '', '');
  const selectedModelOption = (chatModelOptions ?? []).find((option) => option.value === activeAgent.defaultModel);
  const thinkingOptions = uniqueRoutingOptions([
    { value: '', label: 'Model default' },
    ...((selectedModelOption?.thinkingLevels?.length ? selectedModelOption.thinkingLevels : ['off', 'medium', 'high'])
      .map((level) => ({ value: level, label: level[0]?.toUpperCase() + level.slice(1) }))),
  ]);
  const modelRoutingSection = activeAgent.isOwned ? (
    <AgentInspectorSection title="Model routing" detail="Backbone/default auth source + model, fallback auth source + model, and thinking for this owned Bridge agent. These choices are private and not announced in shared chat history.">
      <div className="app-agent-empty-callout rounded-[14px] border border-dashed px-4 py-3 text-[13px] leading-5">
        Use the default model for inbound mentions and reach-outs. If it is unavailable or errors during generation, Kordi retries with the fallback model.
      </div>
      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-3">
        <RoutingSelect
          label="Default route"
          value={selectedDefaultRouteValue}
          options={modelOptions}
          onChange={(option) => {
            if (!canEditModelRouting) return;
            void onUpdateModelRouting?.(activeAgent, {
              defaultModel: option.model || null,
              defaultAuthProvider: option.authProvider ?? null,
              defaultAuthChoice: option.authChoice ?? null,
              fallbackModel: activeAgent.fallbackModel ?? null,
              fallbackAuthProvider: activeAgent.fallbackAuthProvider ?? null,
              fallbackAuthChoice: activeAgent.fallbackAuthChoice ?? null,
              thinking: activeAgent.defaultThinking ?? null,
            });
          }}
        />
        <RoutingSelect
          label="Fallback route"
          value={selectedFallbackRouteValue}
          options={fallbackOptions}
          onChange={(option) => {
            if (!canEditModelRouting) return;
            void onUpdateModelRouting?.(activeAgent, {
              defaultModel: activeAgent.defaultModel || null,
              defaultAuthProvider: activeAgent.defaultAuthProvider ?? null,
              defaultAuthChoice: activeAgent.defaultAuthChoice ?? null,
              fallbackModel: option.model || null,
              fallbackAuthProvider: option.model ? (option.authProvider ?? null) : null,
              fallbackAuthChoice: option.model ? (option.authChoice ?? null) : null,
              thinking: activeAgent.defaultThinking ?? null,
            });
          }}
        />
        <RoutingSelect
          label="Thinking level"
          value={activeAgent.defaultThinking || ''}
          options={thinkingOptions}
          onChange={(option) => {
            if (!canEditModelRouting) return;
            void onUpdateModelRouting?.(activeAgent, {
              defaultModel: activeAgent.defaultModel || null,
              defaultAuthProvider: activeAgent.defaultAuthProvider ?? null,
              defaultAuthChoice: activeAgent.defaultAuthChoice ?? null,
              fallbackModel: activeAgent.fallbackModel ?? null,
              fallbackAuthProvider: activeAgent.fallbackAuthProvider ?? null,
              fallbackAuthChoice: activeAgent.fallbackAuthChoice ?? null,
              thinking: option.value || null,
            });
          }}
        />
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
            {activeSaveFeedback ? (
              <div
                className={cn(
                  'mt-2 text-[12px]',
                  activeSaveFeedback.tone === 'success'
                    ? 'text-emerald-300'
                    : activeSaveFeedback.tone === 'error'
                      ? 'text-rose-300'
                      : 'text-slate-400',
                )}
              >
                {activeSaveFeedback.text}
              </div>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isEditable ? (
              <Button variant="secondary" className="rounded-xl text-[12px]" onClick={() => onReset(activeAgent)}>
                Reset
              </Button>
            ) : null}
            <Button
              className="rounded-xl text-[12px]"
              onClick={() => onMessage?.()}
              disabled={!onMessage || !activeAgent.bridgeHostId || !activeAgent.bridgePeerNodeId}
            >
              Message
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 px-5 py-5">
          {modelRoutingSection}

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
                <div className="app-agent-empty-callout rounded-[14px] border border-dashed px-4 py-3 text-[13px]">
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
              <div className="app-agent-empty-callout rounded-[14px] border border-dashed px-4 py-3 text-[13px]">
                No real loaded-skills payload is exposed for this bridge agent.
              </div>
            )}
          </AgentInspectorSection>

          <div className="app-agent-support-grid grid gap-5">
            <AgentInspectorSection title="Loaded tools">
              {exposesLoadedTools ? (
                <AgentConfigList items={activePersistedConfig?.loadedTools ?? activeAgent.loadedTools} emptyLabel="No tools loaded for this identity." />
              ) : (
                <div className="app-agent-empty-callout rounded-[14px] border border-dashed px-4 py-3 text-[13px]">
                  No real loaded-tools payload is exposed for this bridge agent.
                </div>
              )}
            </AgentInspectorSection>

            <AgentInspectorSection title="Loaded plugins">
              {exposesLoadedPlugins ? (
                <AgentConfigList items={activePersistedConfig?.loadedPlugins ?? activeAgent.loadedPlugins} emptyLabel="No plugins loaded for this identity." />
              ) : (
                <div className="app-agent-empty-callout rounded-[14px] border border-dashed px-4 py-3 text-[13px]">
                  No real loaded-plugins payload is exposed for this bridge agent.
                </div>
              )}
            </AgentInspectorSection>
          </div>

          <AgentInspectorSection title="Identity metadata">
            <div className="app-agent-inner-list overflow-hidden rounded-[14px] border">
              {[
                ['Default provider', activeAgent.defaultProvider],
                ['Default model', activeAgent.defaultModel],
                ['Bridge config', activeAgent.bridgesConfig],
                ['Contact ID', activeAgent.contactId],
              ].map(([label, value], index) => (
                <div key={label} className={cn('app-agent-inner-list-row flex items-start justify-between gap-3 px-3 py-2.5 text-[12px]', index > 0 && 'border-t')}>
                  <div className="app-agent-row-meta">{label}</div>
                  <div className="app-agent-row-title max-w-[60%] min-w-0 break-words text-right">{value}</div>
                </div>
              ))}
            </div>
          </AgentInspectorSection>

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
