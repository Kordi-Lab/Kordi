import { useEffect, useMemo, useRef, useState } from 'react';
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

const SKILL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function getSkillInitial(name: string) {
  const initial = name.trim().charAt(0).toUpperCase();
  return initial >= 'A' && initial <= 'Z' ? initial : null;
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
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDetailsElement>(null);
  const createMenuSummaryRef = useRef<HTMLElement>(null);
  const skillListRef = useRef<HTMLDivElement>(null);
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
  const firstSkillIdByInitial = useMemo(() => {
    const firstSkillIds = new Map<string, string>();
    filteredSkills.forEach((skill) => {
      const initial = getSkillInitial(skill.name);
      if (initial && !firstSkillIds.has(initial)) firstSkillIds.set(initial, skill.id);
    });
    return firstSkillIds;
  }, [filteredSkills]);

  useEffect(() => {
    if (!createMenuOpen || typeof document === 'undefined') return undefined;

    const closeCreateMenu = (restoreFocus = false) => {
      createMenuRef.current?.removeAttribute('open');
      setCreateMenuOpen(false);
      if (restoreFocus) queueMicrotask(() => createMenuSummaryRef.current?.focus());
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && createMenuRef.current?.contains(target)) return;
      closeCreateMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeCreateMenu(true);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [createMenuOpen]);

  const closeCreateMenu = () => {
    createMenuRef.current?.removeAttribute('open');
    setCreateMenuOpen(false);
  };

  const jumpToSkillInitial = (initial: string) => {
    const target = skillListRef.current?.querySelector<HTMLElement>(`[data-skill-initial="${initial}"]`);
    target?.scrollIntoView({ block: 'start', inline: 'nearest' });
  };

  return (
    <aside className="app-agent-studio-rail">
      <header className="app-agent-studio-rail-head">
        <div className="flex items-start justify-between gap-3">
          <h1>Factory</h1>
          <details
            ref={createMenuRef}
            className="app-factory-create-menu"
            onToggle={(event) => setCreateMenuOpen(event.currentTarget.open)}
          >
            <summary
              ref={createMenuSummaryRef}
              className="app-button-quiet app-agent-studio-rail-add"
              aria-label="Start a new Factory build"
              aria-haspopup="menu"
              aria-expanded={createMenuOpen}
            >
              <Plus className="h-4 w-4" />
            </summary>
            <div className="app-factory-create-menu-panel" role="menu" aria-label="Create in Factory">
              <button
                type="button"
                role="menuitem"
                disabled={!canCreateAgent}
                onClick={() => {
                  closeCreateMenu();
                  onCreateArtifact('agent');
                }}
              >
                <Bot className="h-4 w-4" />
                <span><strong>Build agent</strong><small>Create a private Cloud agent</small></span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeCreateMenu();
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
          <button type="button" role="tab" aria-selected={section === 'builds'} className={cn(section === 'builds' && 'is-active')} onClick={() => onSectionChange('builds')}>Agents</button>
          <button type="button" role="tab" aria-selected={section === 'skills'} className={cn(section === 'skills' && 'is-active')} onClick={() => onSectionChange('skills')}>Skills <span>{skills.length}</span></button>
        </div>
        <label className="app-agent-studio-rail-search">
          <Search className="h-4 w-4" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={section === 'skills' ? 'Search skills' : 'Search agents'}
          />
        </label>
      </header>
      {section === 'builds' ? (
        <div className="app-agent-studio-agent-list app-scroll-area is-agent-list">
          <>
            {creatingKind ? (
              <button
                type="button"
                aria-current="true"
                className="app-agent-studio-agent-row app-session-row-active"
                onClick={() => onCreateArtifact(creatingKind)}
              >
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
                <button
                  key={agent.id}
                  type="button"
                  aria-current={isActive ? 'true' : undefined}
                  className={cn('app-agent-studio-agent-row', isActive && 'app-session-row-active')}
                  onClick={() => onOpenAgent(agent.id)}
                >
                  <IdentityAvatar kind="agent" seed={agent.avatarSeed ?? agent.id} name={agent.name} imageUrl={agent.profileImageUrl} className="h-9 w-9 rounded-[12px]" />
                  <span className="min-w-0"><strong>{agent.name}</strong><small>{agent.role} · {capabilityCount} capabilities</small></span>
                  <span className="app-agent-studio-agent-state">{agent.status}</span>
                </button>
              );
            })}
            {filteredAgents.length === 0 && !creatingKind ? <div className="app-agent-studio-rail-empty">No agents match this search.</div> : null}
          </>
        </div>
      ) : (
        <div className="app-agent-studio-skill-list-shell">
          <nav className="app-agent-studio-skill-index" aria-label="Skills alphabetical index">
            {SKILL_ALPHABET.map((initial) => {
              const available = firstSkillIdByInitial.has(initial);
              return (
                <button
                  key={initial}
                  type="button"
                  aria-label={`Jump to ${initial} skills`}
                  disabled={!available}
                  onClick={() => jumpToSkillInitial(initial)}
                >
                  {initial}
                </button>
              );
            })}
          </nav>
          <div ref={skillListRef} className="app-agent-studio-agent-list app-scroll-area is-skill-list">
            {filteredSkills.map((skill) => {
              const initial = getSkillInitial(skill.name);
              const isFirstForInitial = initial !== null && firstSkillIdByInitial.get(initial) === skill.id;
              return (
                <button
                  key={skill.id}
                  type="button"
                  aria-current={skill.id === selectedSkillId ? 'true' : undefined}
                  className={cn('app-agent-studio-agent-row app-list-item is-skill', skill.id === selectedSkillId && 'app-session-row-active')}
                  data-skill-initial={isFirstForInitial ? initial : undefined}
                  onClick={() => onOpenSkill(skill.id)}
                >
                  <span className="min-w-0"><strong>{skill.name}</strong></span>
                </button>
              );
            })}
            {filteredSkills.length === 0 ? <div className="app-agent-studio-rail-empty">{skills.length === 0 ? 'No installed skills yet. Build one or browse Community.' : 'No skills match this search.'}</div> : null}
          </div>
        </div>
      )}
    </aside>
  );
}
