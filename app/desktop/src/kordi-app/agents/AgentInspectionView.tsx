import { Bot, ChevronRight, FileText, Settings2 } from 'lucide-react';

import type { Agent } from '../types';

function ReadOnlySection({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <section className="app-factory-inspect-section">
      <header>
        <h3>{title}</h3>
        {action ? <button type="button" onClick={action.onClick}>{action.label}<ChevronRight className="h-3.5 w-3.5" /></button> : null}
      </header>
      {children}
    </section>
  );
}

export function AgentInspectionView({
  agent,
  onEditInBuild,
}: {
  agent?: Agent;
  onEditInBuild: (agent: Agent) => void;
}) {
  if (!agent) {
    return (
      <main className="app-agent-studio-main">
        <div className="app-skill-library-state"><Bot className="h-5 w-5" /><strong>No agent selected</strong><span>Choose an agent to inspect.</span></div>
      </main>
    );
  }

  const access = agent.cloudAgentAccessScope === 'participant_conversations'
    ? 'People in my chats can mention it'
    : agent.isOwned ? 'Only me' : 'Shared with me';
  const capabilities = [
    ...agent.loadedSkills.map((name) => ({ kind: 'Skill', name })),
    ...agent.loadedTools.map((name) => ({ kind: 'Tool', name })),
    ...agent.loadedPlugins.map((name) => ({ kind: 'Plugin', name })),
  ];

  return (
    <main className="app-agent-studio-main app-factory-inspect-main">
      <header className="app-agent-studio-header">
        <div className="flex min-w-0 items-center gap-3">
          <span className="app-agent-studio-factory-mark" aria-hidden="true"><Bot className="h-5 w-5" /></span>
          <div className="min-w-0"><h2>{agent.name}</h2><p>{agent.role || 'Kordi agent'}</p></div>
        </div>
        <button type="button" className="app-button-quiet app-agent-studio-button is-primary" onClick={() => onEditInBuild(agent)}>Edit in Build</button>
      </header>
      <div className="app-factory-inspect-scroll app-scroll-area">
        <ReadOnlySection title="Profile">
          <dl className="app-factory-inspect-grid">
            <div><dt>Status</dt><dd>{agent.status}</dd></div>
            <div><dt>Access</dt><dd>{access}</dd></div>
            <div><dt>Runtime</dt><dd>{agent.messaging || agent.collaborationConfig}</dd></div>
            <div><dt>Tasks</dt><dd>{agent.tasks}</dd></div>
          </dl>
        </ReadOnlySection>
        <ReadOnlySection title="Instructions" action={{ label: 'Change in Build', onClick: () => onEditInBuild(agent) }}>
          <p className="app-factory-inspect-copy">{agent.systemPrompt.trim() || 'No instructions.'}</p>
        </ReadOnlySection>
        <ReadOnlySection title="Model and reasoning" action={{ label: 'Change in Build', onClick: () => onEditInBuild(agent) }}>
          <dl className="app-factory-inspect-grid">
            <div><dt>Model</dt><dd>{agent.defaultModel || 'Runtime default'}</dd></div>
            <div><dt>Provider</dt><dd>{agent.defaultProvider || agent.defaultAuthProvider || 'Runtime default'}</dd></div>
            <div><dt>Reasoning</dt><dd>{agent.defaultThinking || 'Model default'}</dd></div>
            <div><dt>Fallback</dt><dd>{agent.fallbackModel || 'None'}</dd></div>
          </dl>
        </ReadOnlySection>
        <ReadOnlySection title="Capabilities" action={{ label: 'Manage in Build', onClick: () => onEditInBuild(agent) }}>
          {capabilities.length > 0 ? <div className="app-factory-capability-list">{capabilities.map((capability) => <div key={`${capability.kind}:${capability.name}`}><Settings2 className="h-4 w-4" /><span><strong>{capability.name}</strong><small>{capability.kind}</small></span></div>)}</div> : <p className="app-factory-inspect-empty">No capabilities.</p>}
        </ReadOnlySection>
        <ReadOnlySection title="Files">
          {agent.identityFiles.length > 0 ? <div className="app-factory-file-list">{agent.identityFiles.map((path) => <div key={path}><FileText className="h-4 w-4" /><span>{path}</span></div>)}</div> : <p className="app-factory-inspect-empty">No files.</p>}
        </ReadOnlySection>
      </div>
    </main>
  );
}
