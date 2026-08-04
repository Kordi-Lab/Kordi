import { useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Bot, Globe2, Hammer, Plus, Puzzle, Search, Wrench } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { DesktopAgentBuilderSummary, DesktopSkillLibraryEntry } from '@/lib/desktop';
import { IdentityAvatar } from '../components/IdentityAvatar';
import type { Agent } from '../types';
import type {
  FactoryArtifactKind,
  FactoryLibraryArtifact,
  FactoryLibrarySection,
  FactorySection,
} from './model';

const ARTIFACT_ICONS = {
  agent: Bot,
  skill: Puzzle,
  tool: Wrench,
  plugin: Blocks,
} satisfies Record<FactoryArtifactKind, typeof Bot>;

function artifactLabel(kind: string) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function AgentStudioRail({
  agents,
  activeAgentId,
  builds,
  activeBuildSessionId,
  skills,
  libraryArtifacts,
  selectedLibraryId,
  section,
  librarySection,
  libraryCommunity,
  canCreateAgent,
  onSectionChange,
  onLibrarySectionChange,
  onOpenBuild,
  onOpenAgent,
  onOpenLibraryArtifact,
  onCreateArtifact,
}: {
  agents: Agent[];
  activeAgentId: string;
  builds: DesktopAgentBuilderSummary[];
  activeBuildSessionId: string | null;
  skills: DesktopSkillLibraryEntry[];
  libraryArtifacts: Record<'tool' | 'plugin', FactoryLibraryArtifact[]>;
  selectedLibraryId: string | null;
  section: FactorySection;
  librarySection: FactoryLibrarySection;
  libraryCommunity: boolean;
  canCreateAgent: boolean;
  onSectionChange: (section: FactorySection) => void;
  onLibrarySectionChange: (section: FactoryLibrarySection) => void;
  onOpenBuild: (build: DesktopAgentBuilderSummary) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenLibraryArtifact: (kind: FactoryLibrarySection, artifactId: string) => void;
  onCreateArtifact: (kind: FactoryArtifactKind) => void;
}) {
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDetailsElement>(null);
  const createMenuSummaryRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef<Record<string, number>>({});
  const viewKey = section === 'library' ? `${section}:${librarySection}:${libraryCommunity ? 'community' : 'installed'}` : section;
  const query = queries[viewKey] ?? '';
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const filteredBuilds = useMemo(() => builds.filter((build) => (
    !normalizedQuery || [build.name, build.artifactKind, build.lifecycle]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )), [builds, normalizedQuery]);
  const filteredAgents = useMemo(() => agents.filter((agent) => (
    !normalizedQuery || [agent.name, agent.role, agent.status]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )), [agents, normalizedQuery]);
  const skillArtifacts = useMemo<FactoryLibraryArtifact[]>(() => skills.map((skill) => ({
    id: skill.id,
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    status: skill.enabled ? 'Enabled' : 'Disabled',
    usedBy: agents.filter((agent) => agent.loadedSkills.includes(skill.name)).map((agent) => agent.name),
  })), [agents, skills]);
  const currentLibrary = librarySection === 'skill' ? skillArtifacts : libraryArtifacts[librarySection];
  const filteredLibrary = useMemo(() => currentLibrary.filter((artifact) => (
    !normalizedQuery || [artifact.name, artifact.description, artifact.status, ...artifact.usedBy]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )), [currentLibrary, normalizedQuery]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      list.scrollTop = scrollPositionsRef.current[viewKey] ?? 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [viewKey]);

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

  const createItems: Array<{ kind: FactoryArtifactKind; label: string; detail: string }> = [
    { kind: 'agent', label: 'New agent', detail: 'Shape a private agent draft' },
    { kind: 'skill', label: 'New skill', detail: 'Add reusable guidance' },
    { kind: 'tool', label: 'New tool', detail: 'Define a focused capability' },
    { kind: 'plugin', label: 'New plugin', detail: 'Package an integration' },
  ];

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
              {createItems.map((item) => {
                const Icon = ARTIFACT_ICONS[item.kind];
                return (
                  <button
                    key={item.kind}
                    type="button"
                    role="menuitem"
                    disabled={item.kind === 'agent' && !canCreateAgent}
                    onClick={() => {
                      closeCreateMenu();
                      onCreateArtifact(item.kind);
                    }}
                  >
                    <Icon className="h-4 w-4" />
                    <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                  </button>
                );
              })}
            </div>
          </details>
        </div>
        <div className="app-factory-rail-switch" role="tablist" aria-label="Factory navigation">
          <button type="button" role="tab" aria-selected={section === 'build'} className={cn(section === 'build' && 'is-active')} onClick={() => onSectionChange('build')}>Build</button>
          <button type="button" role="tab" aria-selected={section === 'agents'} className={cn(section === 'agents' && 'is-active')} onClick={() => onSectionChange('agents')}>Agent <span>{agents.length}</span></button>
          <button type="button" role="tab" aria-selected={section === 'library'} className={cn(section === 'library' && 'is-active')} onClick={() => onSectionChange('library')}>Lib <span>{skills.length + libraryArtifacts.tool.length + libraryArtifacts.plugin.length}</span></button>
        </div>
        {section === 'library' ? (
          <div className="app-factory-library-switch" role="tablist" aria-label="Library sections">
            {(['skill', 'tool', 'plugin'] as const).map((kind) => {
              const count = kind === 'skill' ? skills.length : libraryArtifacts[kind].length;
              return <button key={kind} type="button" role="tab" aria-selected={librarySection === kind} className={cn(librarySection === kind && 'is-active')} onClick={() => onLibrarySectionChange(kind)}>{artifactLabel(kind)}s <span>{count}</span></button>;
            })}
          </div>
        ) : null}
        {section === 'library' && librarySection === 'skill' && libraryCommunity ? null : <label className="app-agent-studio-rail-search">
          <Search className="h-4 w-4" />
          <input
            value={query}
            onChange={(event) => setQueries((current) => ({ ...current, [viewKey]: event.currentTarget.value }))}
            placeholder={section === 'build' ? 'Search builds' : section === 'agents' ? 'Search agents' : `Search ${librarySection}s`}
            aria-label={section === 'build' ? 'Search builds' : section === 'agents' ? 'Search agents' : `Search ${librarySection}s`}
          />
        </label>}
      </header>
      <div
        ref={listRef}
        className="app-agent-studio-agent-list app-scroll-area is-agent-list"
        onScroll={(event) => { scrollPositionsRef.current[viewKey] = event.currentTarget.scrollTop; }}
      >
        {section === 'build' ? filteredBuilds.map((build) => (
          <button key={build.sessionId} type="button" aria-current={activeBuildSessionId === build.sessionId ? 'true' : undefined} className={cn('app-agent-studio-agent-row is-compact', activeBuildSessionId === build.sessionId && 'app-session-row-active')} onClick={() => onOpenBuild(build)}>
            <strong>{build.name}</strong>
            <span className={cn('app-agent-studio-agent-state', !build.available && 'is-warning')}>{build.available ? artifactLabel(build.artifactKind) : 'Recover'}</span>
          </button>
        )) : null}
        {section === 'agents' ? filteredAgents.map((agent) => {
          const capabilityCount = agent.loadedSkills.length + agent.loadedTools.length + agent.loadedPlugins.length;
          return (
            <button key={agent.id} type="button" aria-current={agent.id === activeAgentId ? 'true' : undefined} className={cn('app-agent-studio-agent-row', agent.id === activeAgentId && 'app-session-row-active')} onClick={() => onOpenAgent(agent.id)}>
              <IdentityAvatar kind="agent" seed={agent.avatarSeed ?? agent.id} name={agent.name} imageUrl={agent.profileImageUrl} className="h-9 w-9 rounded-[12px]" />
              <span className="min-w-0"><strong>{agent.name}</strong><small>{agent.role} · {capabilityCount} capabilities</small></span>
              <span className="app-agent-studio-agent-state">{agent.status}</span>
            </button>
          );
        }) : null}
        {section === 'library' && librarySection === 'skill' && libraryCommunity ? (
          <div className="app-factory-community-rail-note">
            <Globe2 className="h-5 w-5" />
            <strong>Community skills</strong>
          </div>
        ) : null}
        {section === 'library' && !(librarySection === 'skill' && libraryCommunity) ? filteredLibrary.map((artifact) => (
          <button key={artifact.id} type="button" aria-current={artifact.id === selectedLibraryId ? 'true' : undefined} className={cn('app-agent-studio-agent-row is-compact', artifact.id === selectedLibraryId && 'app-session-row-active')} onClick={() => onOpenLibraryArtifact(artifact.kind, artifact.id)}>
            <strong>{artifact.name}</strong>
            <span className="app-agent-studio-agent-state">{artifact.status}</span>
          </button>
        )) : null}
        {section === 'build' && filteredBuilds.length === 0 ? <div className="app-agent-studio-rail-empty"><Hammer className="mx-auto mb-2 h-4 w-4" />Start a build with the + button.</div> : null}
        {section === 'agents' && filteredAgents.length === 0 ? <div className="app-agent-studio-rail-empty">No agents match this search.</div> : null}
        {section === 'library' && !(librarySection === 'skill' && libraryCommunity) && filteredLibrary.length === 0 ? <div className="app-agent-studio-rail-empty">No {librarySection}s match this search.</div> : null}
      </div>
    </aside>
  );
}
