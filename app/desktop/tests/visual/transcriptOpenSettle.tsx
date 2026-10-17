import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopChatTurnSnapshot, Message } from '../../src/kordi-app/types';
import type { PinActivity } from '../../src/pages/chatsPage.pinActivity';
import { ChatSessionPane } from '../../src/pages/chatsPage.sessionPane';
import { PinnedMessageShelf } from '../../src/pages/PinnedMessageShelf';
import '../../src/index.css';

// A group chat shaped like a busy agent history: background-task replies with
// linked session cards, long folded answers, quoted requests, time dividers, a
// pin notice and the pinned shelf. Pins arrive after the transcript opens, the
// way the cloud pin snapshot does for a newly selected group.
document.documentElement.classList.add('kordi-native-shell');
document.body.classList.add('kordi-native-shell', 'theme-light');
const params = new URLSearchParams(location.search);
const pinDelay = Number(params.get('pinDelay') ?? 400);
const base = Date.UTC(2026, 0, 5, 9, 0);
const minute = 60_000;
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
      arguments: JSON.stringify({ taskTitle: `Synthetic background task ${index}` }), liveOutput: '',
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

function Fixture() {
  const [messages] = useState(buildMessages);
  const [pinsLoaded, setPinsLoaded] = useState(pinDelay < 0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pinDelay < 0) return undefined;
    const timer = window.setTimeout(() => setPinsLoaded(true), pinDelay);
    return () => window.clearTimeout(timer);
  }, []);
  const pinned = pinsLoaded ? [{ message: pinnedMessage(messages), scope: 'shared' as const }] : [];
  return <main className="kordi-app theme-light app-chat-split-workspace" style={{ height: 760, width: 960, display: 'flex', flexDirection: 'column' }}>
    <header className="app-page-header app-chat-pane-header" style={{ height: 52 }}>Synthetic group</header>
    <PinnedMessageShelf items={pinned} onOpenMessage={() => {}} onRequestUnpin={() => {}} />
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatSessionPane viewport={{ sessionKey: 'synthetic-group', messages, scrollRef,
        scrollClassName: 'app-chat-pane-transcript-scroll', composer: <div style={{ height: 72 }}>Composer</div> }}
        actions={{ onOpenSource: () => {}, onOpenArtifact: () => {}, onOpenAuthSettings: () => {}, onStopCollaborationAgentRequest: () => {} }}
        presentation={{ liveTurnSender: 'Synthetic Agent',
          pinnedMessageIds: pinsLoaded ? ['reply-12'] : [],
          pinActivities: pinsLoaded ? [pinActivity] : [],
          relatedAgentSessionStatusById: new Map(),
        }}
        selection={{}} />
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
