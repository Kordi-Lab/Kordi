import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopChatTurnSnapshot, Message } from '../../src/kordi-app/types';
import type { PinActivity } from '../../src/pages/chatsPage.pinActivity';
import { AppShellFrame } from '../../src/app/AppShellFrame';
import { ChatPaneLayout } from '../../src/pages/ChatPaneLayout';
import { ChatSessionPane } from '../../src/pages/chatsPage.sessionPane';
import { PinnedMessageShelf } from '../../src/pages/PinnedMessageShelf';
import type { RelatedAgentSessionRunStatus } from '../../src/features/chat/relatedAgentSessions';
import { saveSession } from '../../src/features/cloud/session';
import { emptyReplayState, ingestReplayWires, replayedAgentMessages, type ReplayWire } from './transcriptOpenSettleReplay';
import '../../src/index.css';

// A group chat shaped like a busy agent history: background-task replies with
// linked session cards, long folded answers, quoted requests, time dividers, a
// pin notice and the pinned shelf. Pins arrive after the transcript opens, the
// way the cloud pin snapshot does for a newly selected group.
document.documentElement.classList.add('kordi-native-shell');
document.body.classList.add('kordi-native-shell', 'theme-light');
const params = new URLSearchParams(location.search);
const pinDelay = Number(params.get('pinDelay') ?? 400);
// The latest agent reply's quote, linked-session status and background tool
// list arrive this many milliseconds after mount (the card's own subsession
// snapshot is served by the spec's network route with the same delay).
const asyncDelay = Number(params.get('asyncDelay') ?? -1);
const TARGET = 'reply-13';
// The background-session card reads its snapshot through the signed-in account.
void saveSession({ token: 'synthetic-token', accountId: 'synthetic-account', expiresAt: '2099-01-01T00:00:00Z' });
const base = Date.UTC(2026, 0, 5, 9, 0);
const minute = 60_000;
const noop = () => {};
const request = (index: number, at: number): Message => ({
  id: `request-${index}`, role: 'user', isOwnMessage: true, senderType: 'human', sender: 'You',
  text: `Synthetic request ${index} for the agent`, time: '', timestampMs: at,
});
function backgroundTurn(index: number, at: number, text: string): DesktopChatTurnSnapshot {
  return {
    id: `cloud-agent-background:reply-${index}`, sessionId: `synthetic-group`, prompt: '', status: 'failed',
    message: text, assistantText: text, thinkingText: '', completed: true, succeeded: false,
    startedAtMs: at, completedAtMs: at, error: null, transcriptRefreshRequired: false,
    tools: [{
      id: `background-session:synthetic-background-${index}`, name: 'task_operator', status: 'completed',
      arguments: JSON.stringify({ action: 'spawn', taskTitle: `Synthetic background task ${index}` }), liveOutput: '',
      resultText: `Background session: ${JSON.stringify({ sessionId: `synthetic-background-${index}`, title: `Synthetic background task ${index}`, status: 'failed' })}`,
      detail: `Synthetic background task ${index}`, isError: false, toolLayer: 'operator',
    }],
  };
}
const longAnswer = (index: number) => `Synthetic summary ${index} is ready.\n\nIt organizes the advice on:\n\n${
  Array.from({ length: 12 }, (_, line) => `- Synthetic topic ${line + 1} with a short explanation`).join('\n')}`;
function buildMessages(): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < 14; index += 1) {
    const at = base + index * 90 * minute;
    messages.push(request(index, at));
    const text = index % 2 === 0 ? longAnswer(index) : `Synthetic agent reply ${index}. I will share the finished file here when it is ready.`;
    messages.push({
      id: `reply-${index}`, role: 'owned-agent', senderType: 'agent', sender: 'Synthetic Agent', text,
      time: '', timestampMs: at + minute, replyToMessageId: `request-${index}`,
      sourceMessage: { messageId: `request-${index}`, senderLabel: 'You', text: `Synthetic request ${index} for the agent` },
      ...(index % 3 !== 2 ? { turn: backgroundTurn(index, at + minute, text) } : {}),
    });
  }
  messages.push(request(99, base + 40 * 60 * minute));
  return messages;
}
const pinnedMessage = (messages: Message[]) => messages.find(message => message.id === 'reply-12')!;
const pinActivity: PinActivity = { id: 'pin-activity:synthetic', label: 'You pinned a message', timestampMs: base + 13 * 90 * minute + 5 * minute };

// Before the late data arrives, the reply has no quote and no background tools.
function withoutLateParts(messages: Message[]) {
  return messages.map(message => message.id !== TARGET ? message : {
    ...message, sourceMessage: undefined, replyToMessageId: undefined,
    turn: message.turn ? { ...message.turn, tools: [] } : undefined,
  });
}

// Replay mode: the latest agent reply and its background follow-up go through
// the app's group ingestion, first as the stored result of an earlier sync and
// then again in the replay passes that run after the group opens.
const replay = params.has('replay');
const replayRequestAt = base + 13 * 90 * minute;
const parentWire: ReplayWire = { id: 'msg:cloud-agent:turn-parent', requestId: 'request-13', text: 'Synthetic agent reply 13. I will share the finished file here when it is ready.', createdAtMs: replayRequestAt + minute, tools: true, sequence: 30 };
const followUpWire: ReplayWire = { id: 'msg:cloud-agent:turn-follow-up', requestId: 'follow-up-13', text: longAnswer(13), createdAtMs: replayRequestAt + 4 * minute, tools: false, sequence: 31 };
const storedReplayState = replay
  ? await ingestReplayWires(emptyReplayState('request-13', replayRequestAt), 'request-13', [parentWire, followUpWire])
  : null;
const replayPasses: Array<[number, ReplayWire[]]> = [[0, [followUpWire]], [150, [parentWire, followUpWire]], [500, [parentWire]], [1200, [followUpWire]]];

function withReplayedReplies(messages: Message[], state: typeof storedReplayState) {
  if (!state) return messages;
  const replies = replayedAgentMessages(state).map(reply => ({
    ...reply, sender: 'Synthetic Agent', time: '',
    sourceMessage: { messageId: 'request-13', senderLabel: 'You', text: 'Synthetic request 13 for the agent' },
  }));
  return messages.flatMap(message => message.id === TARGET ? replies : [message]);
}

function Fixture() {
  const [replayState, setReplayState] = useState(storedReplayState);
  useEffect(() => {
    if (!storedReplayState) return undefined;
    let current = storedReplayState;
    const timers = replayPasses.map(([delay, wires]) => window.setTimeout(() => {
      void ingestReplayWires(current, 'request-13', wires).then(next => { current = next; setReplayState(next); });
    }, delay));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, []);
  const [allMessages] = useState(buildMessages);
  const [lateParts, setLateParts] = useState(asyncDelay < 0);
  useEffect(() => {
    if (asyncDelay < 0) return undefined;
    const timer = window.setTimeout(() => setLateParts(true), asyncDelay);
    return () => window.clearTimeout(timer);
  }, []);
  const messages = useMemo(() => withReplayedReplies(lateParts ? allMessages : withoutLateParts(allMessages), replayState), [allMessages, lateParts, replayState]);
  const statusById = useMemo(() => new Map<string, RelatedAgentSessionRunStatus>(
    lateParts ? [['synthetic-background-13', 'failed']] : [],
  ), [lateParts]);
  const [pinsLoaded, setPinsLoaded] = useState(pinDelay < 0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pinDelay < 0) return undefined;
    const timer = window.setTimeout(() => setPinsLoaded(true), pinDelay);
    return () => window.clearTimeout(timer);
  }, []);
  const pinned = pinsLoaded ? [{ message: pinnedMessage(messages), scope: 'shared' as const }] : [];
  return <AppShellFrame rootThemeClass="theme-light" isNativeShell isLayoutResizing={false}
    windowSize={{ width: 1280, height: 820 }} leftWorkspaceWidth={280}
    isSingleWorkspacePage={false} showSessionRail collapseChatSessions={false}
    showRightDetailRail={false} isDetailPanelCollapsed detailRailWidth={0}
    onSessionResizeMouseDown={noop} onDetailResizeMouseDown={noop}
    sidebar={<aside className="app-side-shell flex h-full"><div className="app-session-panel flex-1">Synthetic group</div></aside>}
    mainContent={<ChatPaneLayout hasHeader>
      <header className="app-page-header app-chat-pane-header">Synthetic group</header>
      <div className="app-chat-theme-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-chat-destination-page="messages">
        <PinnedMessageShelf items={pinned} onOpenMessage={noop} onRequestUnpin={noop} />
        <ChatSessionPane viewport={{ sessionKey: 'synthetic-group', messages, scrollRef,
          scrollClassName: 'app-chat-pane-transcript-scroll', composer: <div style={{ height: 72 }}>Composer</div> }}
          actions={{ onOpenSource: noop, onOpenArtifact: noop, onOpenAuthSettings: noop, onStopCollaborationAgentRequest: noop }}
          presentation={{ liveTurnSender: 'Synthetic Agent',
            pinnedMessageIds: pinsLoaded ? ['reply-12'] : [],
            pinActivities: pinsLoaded ? [pinActivity] : [],
            relatedAgentSessionStatusById: statusById,
          }}
          selection={{}} />
      </div>
    </ChatPaneLayout>} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
