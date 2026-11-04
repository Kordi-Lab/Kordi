import type { PersonalAgentEntry } from './personalAgentStore';

/** A personal session's compact header: the agent's name followed by online status. */
export function PersonalAgentHeaderTitle({ entry }: { entry: PersonalAgentEntry }) {
  return (
    <div
      className="app-chat-header-title app-page-header-title-row app-chat-pane-title-row app-personal-agent-header flex min-w-0 items-center"
      data-personal-agent-header={entry.agentId}
      data-kordi-window-drag="false"
    >
      <h2 title={entry.name}>{entry.name}</h2>
      <span className="app-personal-agent-header-status" data-chat-session-subtitle="true">
        Online
      </span>
    </div>
  );
}
