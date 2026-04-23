import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { Agent } from '../types';
import { formatHistoryPath, getAgentConfigPath, type AgentConfigDraft, type AgentEditHistoryEntry, type AgentSaveFeedback, type PersistedAgentConfig } from './model';
import { AgentConfigList, AgentInspectorSection } from './shared';

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

export function AgentDetailPane({
  activeAgent,
  activeAgentConfig,
  activePersistedConfig,
  activeIdentityFile,
  activeFilePreview,
  activeSaveFeedback,
  activeEditingSection,
  availableSkills,
  onReset,
  onMessage,
  onStartEditing,
  onSave,
  onCancelEditing,
  onPromptChange,
  onToggleSkill,
  onSelectIdentityFile,
}: {
  activeAgent?: Agent;
  activeAgentConfig: AgentConfigDraft | null;
  activePersistedConfig: PersistedAgentConfig | null;
  activeIdentityFile: string | null;
  activeFilePreview: { status: 'idle' | 'loading' | 'ready' | 'error'; text: string; error?: string };
  activeSaveFeedback: AgentSaveFeedback | null;
  activeEditingSection: 'prompt' | 'skills' | null;
  availableSkills: string[];
  onReset: (agent: Agent) => void;
  onMessage?: () => void;
  onStartEditing: (agentId: string, section: 'prompt' | 'skills') => void;
  onSave: (agent: Agent, section: 'prompt' | 'skills') => void;
  onCancelEditing: (agent: Agent) => void;
  onPromptChange: (agentId: string, value: string) => void;
  onToggleSkill: (agentId: string, skill: string, selected: boolean) => void;
  onSelectIdentityFile: (agentId: string, file: string) => void;
}) {
  if (!activeAgent || !activeAgentConfig) {
    return (
      <section className="flex min-h-0 min-w-0 flex-col bg-[rgba(20,20,24,0.42)] text-white">
        <div className="flex h-full items-center justify-center px-6 text-center text-slate-400">
          Select an agent to inspect its prompt, identity files, skills, tools, and plugins.
        </div>
      </section>
    );
  }

  const activeConfigPath = getAgentConfigPath(activeAgent);

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-[rgba(20,20,24,0.42)] text-white">
      <div className="border-b border-white/6 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[12px] font-medium text-slate-400">Agent configuration</div>
            <div className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-white">{activeAgent.name}</div>
            <div className="mt-1 text-[13px] text-slate-400">{activeAgent.id} • isolated settings for this identity only</div>
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
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" className="rounded-xl text-[12px]" onClick={() => onReset(activeAgent)}>
              Reset
            </Button>
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
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <AgentInspectorSection title="System prompt" detail="Keep this short, explicit, and identity-specific.">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">Source: {activeConfigPath ?? 'draft only'}</div>
                {activeEditingSection === 'prompt' ? (
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onCancelEditing(activeAgent)}>
                      Cancel
                    </Button>
                    <Button className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onSave(activeAgent, 'prompt')}>
                      Save
                    </Button>
                  </div>
                ) : (
                  <Button variant="secondary" className="h-8 rounded-[10px] px-3 text-[12px]" onClick={() => onStartEditing(activeAgent.id, 'prompt')}>
                    Edit
                  </Button>
                )}
              </div>
              {activeEditingSection === 'prompt' ? (
                <textarea
                  rows={9}
                  value={activeAgentConfig.systemPrompt}
                  onChange={(event) => onPromptChange(activeAgent.id, event.target.value)}
                  className="app-input-shell app-settings-field min-h-[188px] w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                  placeholder="Add the standing instruction for this agent"
                />
              ) : (
                <div className="rounded-[14px] border border-white/6 bg-white/[0.03] px-4 py-3 text-[13px] leading-7 text-slate-200">
                  {activeAgentConfig.systemPrompt}
                </div>
              )}
            </AgentInspectorSection>

            <AgentInspectorSection title="Loaded skills" detail="Toggle the skills this agent should carry.">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">Persisted in {activeConfigPath ?? 'draft only'}</div>
                {activeEditingSection === 'skills' ? (
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
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {availableSkills.map((skill) => {
                  const selected = activeAgentConfig.loadedSkills.includes(skill);
                  return (
                    <button
                      key={skill}
                      type="button"
                      disabled={activeEditingSection !== 'skills'}
                      onClick={() => onToggleSkill(activeAgent.id, skill, selected)}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-[12px] transition',
                        selected
                          ? 'border-white/14 bg-white/[0.08] text-white'
                          : 'border-white/8 bg-transparent text-slate-400',
                        activeEditingSection === 'skills'
                          ? 'hover:border-white/12 hover:text-slate-200'
                          : 'cursor-default opacity-80',
                      )}
                    >
                      {skill}
                    </button>
                  );
                })}
              </div>
            </AgentInspectorSection>
          </div>

          <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
            <AgentInspectorSection title="Identity files" detail="Select a file to inspect its contents.">
              <div className="space-y-1.5">
                {activeAgent.identityFiles.map((file) => {
                  const selected = activeIdentityFile === file;
                  return (
                    <button
                      key={file}
                      type="button"
                      onClick={() => onSelectIdentityFile(activeAgent.id, file)}
                      className={cn(
                        'block w-full rounded-[12px] px-3 py-2 text-left text-[12px] transition',
                        selected ? 'bg-white/[0.08] text-white' : 'text-slate-300 hover:bg-white/[0.04]',
                      )}
                    >
                      <div className="truncate">{file.split('/').pop()}</div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-500">{file}</div>
                    </button>
                  );
                })}
              </div>
            </AgentInspectorSection>

            <AgentInspectorSection title="File preview" detail={activeIdentityFile ?? 'No file selected'} className="bg-[#16161a]">
              <div className="overflow-hidden rounded-[14px] border border-white/6 bg-black/20">
                <div className="border-b border-white/6 px-4 py-2 text-[11px] text-slate-500">
                  {activeFilePreview.status === 'loading'
                    ? 'Loading real file…'
                    : activeFilePreview.status === 'error'
                      ? `Preview fallback • ${activeFilePreview.error ?? 'Unable to read file'}`
                      : 'Preview'}
                </div>
                <pre className="max-h-[420px] overflow-auto px-4 py-4 font-mono text-[12px] leading-6 text-slate-300">{activeFilePreview.text}</pre>
              </div>
            </AgentInspectorSection>
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <AgentInspectorSection title="Tools and plugins">
              <div className="space-y-4">
                <div>
                  <div className="mb-2 text-[11px] text-slate-500">Loaded tools</div>
                  <AgentConfigList items={activePersistedConfig?.loadedTools ?? activeAgent.loadedTools} emptyLabel="No tools loaded for this identity." />
                </div>
                <div>
                  <div className="mb-2 text-[11px] text-slate-500">Loaded plugins</div>
                  <AgentConfigList items={activePersistedConfig?.loadedPlugins ?? activeAgent.loadedPlugins} emptyLabel="No plugins loaded for this identity." />
                </div>
              </div>
            </AgentInspectorSection>

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
          </div>

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
