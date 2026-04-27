import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { EditableIdentityAvatar } from '../components/EditableIdentityAvatar';
import type { Agent } from '../types';
import { formatHistoryPath, getAgentConfigPath, type AgentConfigDraft, type AgentEditHistoryEntry, type AgentSaveFeedback, type PersistedAgentConfig } from './model';
import { AgentConfigList, AgentInspectorSection } from './shared';

type DetailTarget = { kind: 'prompt' } | { kind: 'file'; path: string } | null;

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

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
                  <div className="app-agent-row-title max-w-[60%] text-right">{value}</div>
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
