import { useEffect, useRef } from 'react';
import { RadioTower } from 'lucide-react';
import { cn } from '@/lib/utils';
import { closePersonalAgentPage, openPersonalAgentPage, registerPersonalAgentSessionOpener, usePersonalAgentPageOpen } from './personalAgentPageState';
import { personalAgentStatusLine, useDefaultPersonalAgentStatus } from './personalAgentStatus';

/**
 * The Personal agent entry under New in Agent Chats: a status line, not a
 * chat. It opens the Personal agent page; the agent's chat is an ordinary
 * chat in the list.
 */
export function PersonalAgentStatusEntry({ activeConvId, onSelectChatSession }: {
  activeConvId: string;
  onSelectChatSession: (sessionId: string) => void;
}) {
  const status = useDefaultPersonalAgentStatus();
  const open = usePersonalAgentPageOpen();
  useEffect(() => registerPersonalAgentSessionOpener(onSelectChatSession), [onSelectChatSession]);
  // Choosing a chat anywhere changes the selection and closes the page.
  const selection = useRef(activeConvId);
  useEffect(() => {
    if (selection.current === activeConvId) return;
    selection.current = activeConvId;
    closePersonalAgentPage();
  }, [activeConvId]);
  useEffect(() => closePersonalAgentPage, []);
  const line = personalAgentStatusLine(status);
  const live = status?.connected === true && status.proactive;
  return (
    <div className="app-personal-agent-entry-row">
      <button
        type="button"
        data-testid="personal-agent-entry"
        className={cn('app-personal-agent-entry', open && 'is-active')}
        aria-current={open ? 'page' : undefined}
        onClick={() => (open ? closePersonalAgentPage() : openPersonalAgentPage())}
      >
        <span className={cn('app-personal-agent-entry-icon', live && 'is-live')} aria-hidden="true"><RadioTower className="h-[15px] w-[15px]" /></span>
        <span className="app-personal-agent-entry-main">
          <span className="app-personal-agent-entry-title">Personal agent</span>
          {line ? <span className="app-personal-agent-entry-status">{line}</span> : null}
        </span>
      </button>
    </div>
  );
}
