import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { PersonalAgentEntry } from './personalAgentStore';

/** A personal session's header: the agent's avatar with its online dot, its name, and "Online". */
export function PersonalAgentHeaderTitle({ entry }: { entry: PersonalAgentEntry }) {
  return (
    <div
      className="app-chat-header-title app-page-header-title-row app-chat-pane-title-row app-personal-agent-header flex min-w-0 items-center"
      data-personal-agent-header={entry.agentId}
      data-kordi-window-drag="false"
    >
      <IdentityAvatar
        kind="agent"
        seed={entry.avatarSeed}
        name={entry.name}
        imageUrl={entry.profileImageUrl}
        className="app-personal-agent-header-avatar"
        presenceStatus="online"
        presenceLabel={`${entry.name} is online`}
      />
      <div className="app-personal-agent-header-text">
        <h2 title={entry.name}>{entry.name}</h2>
        <span data-chat-session-subtitle="true">Online</span>
      </div>
    </div>
  );
}
