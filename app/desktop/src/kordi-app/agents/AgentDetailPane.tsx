import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { EditableIdentityAvatar } from '../components/EditableIdentityAvatar';
import { getLocalHumanAvatarKey } from '../components/IdentityAvatar';
import type { Agent } from '../types';
import { formatHistoryPath, getAgentConfigPath, type AgentConfigDraft, type AgentEditHistoryEntry, type AgentSaveFeedback, type PersistedAgentConfig } from './model';
import { AgentConfigList, AgentInspectorSection } from './shared';

type DetailTarget = { kind: 'prompt' } | { kind: 'file'; path: string } | null;

function EditHistorySection({ entries }: { entries: AgentEditHistoryEntry[] }) {
  return (
    <AgentInspectorSection title="Edit history" detail="Recent saved changes, shown in file path style.">
      <div className="overflow-hidden rounded-[14px] border border-white/6 bg-white/[0.02]">
        {entries.length > 0 ? (
          entries.map((entry, index) => (
            <div key={`${entry.path}-${entry.timestamp}-${index}`} className={cn('px-3 py-3', index > 0 && 'border-t border-white/6')}>
              <div className="font-mono text-[11px] text-slate-400">{formatHistoryPath(entry.path)}</div>
              <div className="mt-1 text-[13px] text-slate-100">{entry.action}</div>
              <div className="mt-1 text-[11px] text-slate-500">{entry.timestamp}</div>
            </div>
          ))
        ) : (
          <div className="px-3 py-3 text-[13px] text-slate-500">No saved edits yet.</div>
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
        'rounded-[14px] border px-3 py-3 text-left transition',
        active ? 'border-white/12 bg-white/[0.07]' : 'border-white/6 bg-white/[0.02] hover:bg-white/[0.045]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-white">{label}</div>
          <div className="mt-1 text-[12px] leading-5 text-slate-400">{detail}</div>
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
      <section className="flex min-h-0 min-w-0 flex-col bg-[rgba(20,20,24,0.42)] text-white">
        <div className="flex h-full items-center justify-center px-6 text-center text-slate-400">
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
    <section className="flex min-h-0 min-w-0 flex-col bg-[rgba(20,20,24,0.42)] text-white">
      <div className="border-b border-white/6 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <EditableIdentityAvatar
              kind="agent"
              seed={activeAgent.id}
              name={activeAgent.name}
              imageUrl={activeAgent.profileImageUrl}
              avatarKey={activeAgent.avatarKey}
              ownerSeed={activeAgent.ownerAvatarKey ?? (activeAgent.bridgeOwnerName ? `human:${activeAgent.bridgeOwnerName}` : getLocalHumanAvatarKey())}
              label={`${activeAgent.name} avatar`}
              compact
              className="mt-0.5 h-12 w-12 border border-white/10"
            />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-slate-400">Agent inspector</div>
              <div className="mt-1 truncate text-[24px] font-semibold tracking-[-0.02em] text-white">{activeAgent.name}</div>
              <div className="mt-1 text-[13px] text-slate-400">Middle panel lists each item. Click prompt or markdown files to open detail on the right.</div>
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
                trailing={<div className="text-[11px] text-slate-500">{activeConfigPath ?? 'runtime'}</div>}
              />

              {exposesIdentityFiles ? (
                activeAgent.identityFiles.map((file) => (
                  <InspectorRow
                    key={file}
                    label={file.split('/').pop() ?? file}
                    detail={file}
                    active={selectedFilePath === file}
                    onClick={() => onSelectIdentityFile(activeAgent.id, file)}
                    trailing={<div className="text-[11px] text-slate-500">Open</div>}
                  />
                ))
              ) : (
                <div className="rounded-[14px] border border-dashed border-white/8 px-4 py-3 text-[13px] text-slate-400">
                  No real identity files are exposed for this bridge agent.
                </div>
              )}
            </div>
          </AgentInspectorSection>

          <AgentInspectorSection title="Loaded skills" detail="Show and edit the skill list here without opening a full detail pane.">
            {exposesLoadedSkills ? (
              <>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="text-[11px] text-slate-500">Persisted in {activeConfigPath ?? (hasRuntimePrompt ? 'current runtime' : 'not exposed by bridge agent')}</div>
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
                    <div className="text-[11px] text-slate-500">Runtime-managed</div>
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
                          'rounded-full border px-3 py-1.5 text-[12px] transition',
                          selected
                            ? 'border-white/14 bg-white/[0.08] text-white'
                            : 'border-white/8 bg-transparent text-slate-400',
                          isEditable && activeEditingSection === 'skills'
                            ? 'hover:border-white/12 hover:text-slate-200'
                            : 'cursor-default opacity-80',
                        )}
                      >
                        {skill}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="rounded-[14px] border border-dashed border-white/8 px-4 py-3 text-[13px] text-slate-400">
                No real loaded-skills payload is exposed for this bridge agent.
              </div>
            )}
          </AgentInspectorSection>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <AgentInspectorSection title="Loaded tools">
              {exposesLoadedTools ? (
                <AgentConfigList items={activePersistedConfig?.loadedTools ?? activeAgent.loadedTools} emptyLabel="No tools loaded for this identity." />
              ) : (
                <div className="rounded-[14px] border border-dashed border-white/8 px-4 py-3 text-[13px] text-slate-400">
                  No real loaded-tools payload is exposed for this bridge agent.
                </div>
              )}
            </AgentInspectorSection>

            <AgentInspectorSection title="Loaded plugins">
              {exposesLoadedPlugins ? (
                <AgentConfigList items={activePersistedConfig?.loadedPlugins ?? activeAgent.loadedPlugins} emptyLabel="No plugins loaded for this identity." />
              ) : (
                <div className="rounded-[14px] border border-dashed border-white/8 px-4 py-3 text-[13px] text-slate-400">
                  No real loaded-plugins payload is exposed for this bridge agent.
                </div>
              )}
            </AgentInspectorSection>
          </div>

          <AgentInspectorSection title="Identity metadata">
            <div className="overflow-hidden rounded-[14px] border border-white/6 bg-white/[0.02]">
              {[
                ['Default provider', activeAgent.defaultProvider],
                ['Default model', activeAgent.defaultModel],
                ['Bridge config', activeAgent.bridgesConfig],
                ['Contact ID', activeAgent.contactId],
              ].map(([label, value], index) => (
                <div key={label} className={cn('flex items-start justify-between gap-3 px-3 py-2.5 text-[12px]', index > 0 && 'border-t border-white/6')}>
                  <div className="text-slate-500">{label}</div>
                  <div className="max-w-[60%] text-right text-slate-200">{value}</div>
                </div>
              ))}
            </div>
          </AgentInspectorSection>

          <EditHistorySection entries={activePersistedConfig?.editHistory ?? []} />

          <AgentInspectorSection title="Recent activity">
            <div className="overflow-hidden rounded-[14px] border border-white/6 bg-white/[0.02]">
              {activeAgent.lastActivities.map((activity, index) => (
                <div key={activity} className={cn('px-3 py-2.5 text-[13px] text-slate-200', index > 0 && 'border-t border-white/6')}>
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
