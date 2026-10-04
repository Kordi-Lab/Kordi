import type { ReactNode } from 'react';
import { useMessageLayout } from '@/app/messageLayoutPreference';
import { transcriptMessageDomId } from '@/features/chat/transcriptNavigation';
import type { DesktopChatTurnSnapshot, MessageSourceReference } from '../types';
import { IdentityAvatar, useLocalAgentAvatarSeed } from './IdentityAvatar';
import { ThreadMessageHeader } from './ThreadMessageHeader';
import { SourceMessageQuoteRow } from './transcriptReplyAttribution';

export function LiveTurnMessageFrame({ turn, sender, showSourceQuote, onNavigateToMessage, children }: {
  turn: DesktopChatTurnSnapshot;
  sender: string;
  showSourceQuote: boolean;
  onNavigateToMessage?: (id: string, source?: MessageSourceReference) => void;
  children: ReactNode;
}) {
  const threadLayout = useMessageLayout() === 'threads';
  const agentAvatarSeed = useLocalAgentAvatarSeed();
  const id = turn.id ? transcriptMessageDomId(turn.id) : undefined;
  if (!threadLayout) return (
    <div id={id} data-transcript-message-root="true" className="flex w-full max-w-[min(100%,58rem)] flex-col items-start gap-0.5 py-0.5">
      <div className="app-message-meta">{sender}</div>
      {children}
    </div>
  );
  const timestampMs = turn.startedAtMs;
  const time = typeof timestampMs === 'number' && Number.isFinite(timestampMs)
    ? new Date(timestampMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div id={id} data-transcript-message-root="true" className="app-thread-message-row app-thread-turn flex w-full flex-col">
      {showSourceQuote && turn.sourceMessage ? <SourceMessageQuoteRow sourceMessage={turn.sourceMessage} onNavigateToMessage={onNavigateToMessage} className="app-thread-quote-row" /> : null}
      <div className="app-thread-message-main flex">
        <IdentityAvatar kind="agent" seed={agentAvatarSeed} name={sender} className="h-7 w-7 shrink-0" />
        <div className="app-message-hover-time-trigger min-w-0 flex-1">
          <ThreadMessageHeader name={sender} msg={{ role: 'owned-agent', text: '', time, timestampMs }} />
          {children}
        </div>
      </div>
    </div>
  );
}
