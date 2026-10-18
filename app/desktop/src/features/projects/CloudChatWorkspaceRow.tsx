import { Folder, Laptop } from 'lucide-react';
import { projectForChat, useChatProjects } from './chatProjects';

/** The workspace row of a chat that runs in Kordi Cloud: always shown, never editable here. */
export function CloudChatWorkspaceRow({ sessionId }: { sessionId: string }) {
  const projects = useChatProjects();
  if (!projects?.enabled) return null;
  const project = projectForChat(projects.projects, sessionId);
  return <div className="chat-workspace-controls" data-chat-workspace-cloud>
    <div className="chat-workspace-selector-row chat-workspace-selector-row-cloud" role="group" aria-label="Chat workspace"
      aria-disabled="true" aria-description="Runs in Kordi Cloud" title="Runs in Kordi Cloud">
      {project ? <span className="chat-workspace-pill"><Folder size={13} aria-hidden="true" />{project.name}</span>
        : <span className="chat-workspace-pill chat-workspace-location"><Laptop size={14} aria-hidden="true" />Local</span>}
    </div>
  </div>;
}
