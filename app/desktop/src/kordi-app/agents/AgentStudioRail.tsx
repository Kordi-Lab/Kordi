import { useMemo, useState, type MouseEvent } from 'react';
import { Bot, Plus, Puzzle, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { DesktopSkillLibraryEntry } from '@/lib/desktop';
import { IdentityAvatar } from '../components/IdentityAvatar';
import type { Agent } from '../types';
import type {
  AgentStudioConfigDraft,
  FactoryArtifactKind,
  FactorySection,
} from './model';

function closeCreateMenu(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.closest('details')?.removeAttribute('open');
}

export function AgentStudioRail({
  agents,
  activeAgentId,
  creatingKind,
  agentConfigs,
  skills,
  selectedSkillId,
  section,
  canCreateAgent,
  onSectionChange,
  onOpenAgent,
  onOpenSkill,
  onCreateArtifact,
}: {
  agents: Agent[];
  activeAgentId: string;
  creatingKind: FactoryArtifactKind | null;
  agentConfigs: Record<string, AgentStudioConfigDraft>;
  skills: DesktopSkillLibraryEntry[];
  selectedSkillId: string | null;
  section: FactorySection;
  canCreateAgent: boolean;
  onSectionChange: (section: FactorySection) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenSkill: (skillId: string) => void;
  onCreateArtifact: (kind: FactoryArtifactKind) => void;
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredAgents = useMemo(() => {
    if (!normalizedQuery) return agents;
    return agents.filter((agent) => [agent.name, agent.role, agent.status]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
  }, [agents, normalizedQuery]);
  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return skills;
    return skills.filter((skill) => [skill.name, skill.description, skill.origin, skill.provider ?? '']
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
  }, [normalizedQuery, skills]);

  return (
    <aside className="app-agent-studio-rail">
      <header className="app-agent-studio-rail-head">
        <div className="flex items-start justify-between gap-3">
          <div><h1>Factory</h1><p>Build agents, skills, tools, and workflows</p></div>
          <details className="app-factory-create-menu">
            <summary className="app-agent-studio-rail-add" aria-label="Start a new Factory build"><Plus className="h-4 w-4" /></summary>
            <div className="app-factory-create-menu-panel" role="menu" aria-label="Create in Factory">
              <button
                type="button"
                role="menuitem"
                disabled={!canCreateAgent}
                onClick={(event) => {
                  closeCreateMenu(event);
                  onCreateArtifact('agent');
                }}
              >
                <Bot className="h-4 w-4" />
                <span><strong>Build agent</strong><small>Create a private Cloud agent</small></span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  closeCreateMenu(event);
                  onCreateArtifact('skill');
                }}
              >
                <Puzzle className="h-4 w-4" />
                <span><strong>Build skill</strong><small>Create a reusable Kordi skill</small></span>
              </button>
            </div>
          </details>
        </div>
        <div className="app-factory-rail-switch" role="tablist" aria-label="Factory navigation">
          <button type="button" role="tab" aria-selected={section === 'builds'} className={cn(section === 'builds' && 'is-active')} onClick={() => onSectionChange('builds')}>Builds</button>
          <button type="button" role="tab" aria-selected={section === 'skills'} className={cn(section === 'skills' && 'is-active')} onClick={() => onSectionChange('skills')}>Skills <span>{skills.length}</span></button>
        </div>
        <label className="app-agent-studio-rail-search">
          <Search className="h-4 w-4" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={section === 'skills' ? 'Search skills' : 'Search factory projects'}
          />
        </label>
      </header>
      <div className="app-agent-studio-agent-list">
        {section === 'builds' ? (
          <>
            {creatingKind ? (
              <button type="button" className="app-agent-studio-agent-row is-active" onClick={() => onCreateArtifact(creatingKind)}>
                <span className="app-agent-studio-draft-avatar">{creatingKind === 'skill' ? <Puzzle className="h-4 w-4" /> : <Bot className="h-4 w-4" />}</span>
                <span className="min-w-0"><strong>{creatingKind === 'skill' ? 'New skill' : 'New agent'}</strong><small>Private Factory draft</small></span>
                <span className="app-agent-studio-agent-state is-draft">Draft</span>
              </button>
            ) : null}
            {filteredAgents.map((agent) => {
              const config = agentConfigs[agent.id];
              const isActive = !creatingKind && agent.id === activeAgentId;
              const capabilityCount = (config?.loadedSkills.length ?? agent.loadedSkills.length)
                + (config?.loadedTools.length ?? agent.loadedTools.length)
                + (config?.loadedPlugins.length ?? agent.loadedPlugins.length);
              return (
                <button key={agent.id} type="button" className={cn('app-agent-studio-agent-row', isActive && 'is-active')} onClick={() => onOpenAgent(agent.id)}>
                  <IdentityAvatar kind="agent" seed={agent.avatarSeed ?? agent.id} name={agent.name} imageUrl={agent.profileImageUrl} className="h-9 w-9 rounded-[12px]" />
                  <span className="min-w-0"><strong>{agent.name}</strong><small>{agent.role} · {capabilityCount} capabilities</small></span>
                  <span className="app-agent-studio-agent-state">{agent.status}</span>
                </button>
              );
            })}
            {filteredAgents.length === 0 && !creatingKind ? <div className="app-agent-studio-rail-empty">No Factory builds match this search.</div> : null}
          </>
        ) : (
          <>
            {filteredSkills.map((skill) => (
              <button key={skill.id} type="button" className={cn('app-agent-studio-agent-row', skill.id === selectedSkillId && 'is-active')} onClick={() => onOpenSkill(skill.id)}>
                <span className="app-agent-studio-skill-avatar"><Puzzle className="h-4 w-4" /></span>
                <span className="min-w-0"><strong>{skill.name}</strong><small>{skill.origin === 'community' ? skill.provider ?? 'Community' : skill.sourceLabel}</small></span>
                <span className={cn('app-agent-studio-agent-state', skill.enabled && 'is-enabled')}>{skill.enabled ? 'On' : 'Off'}</span>
              </button>
            ))}
            {filteredSkills.length === 0 ? <div className="app-agent-studio-rail-empty">{skills.length === 0 ? 'No installed skills yet. Build one or browse Community.' : 'No skills match this search.'}</div> : null}
          </>
        )}
      </div>
      <footer className="app-agent-studio-rail-footer"><span /><span>Factory runtime connected</span></footer>
    </aside>
  );
}
