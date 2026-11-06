import './previewChatTheme';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { estimateTranscriptMessageHeight } from '../../src/features/chat/transcriptHeightEstimate';
import { __setSessionBackendForTests, type StoredSession } from '../../src/features/cloud/session';
import { KORDI_SYSTEM_AVATAR_URL } from '../../src/features/systemAgent/systemAgentIdentity';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message, MessagePlanCard } from '../../src/kordi-app/types';
import '../../src/index.css';

// The signed-in account loads asynchronously, as the desktop keychain does.
const session: StoredSession = { token: 'synthetic-token', accountId: 'acct_me', expiresAt: '2099-01-01T00:00:00Z' };
__setSessionBackendForTests({
  load: () => new Promise(resolve => setTimeout(() => resolve(session), 30)),
  save: async () => undefined,
  clear: async () => undefined,
});

const planCard = (chat: string): MessagePlanCard => ({
  eventId: `plan-${chat}`, revision: 2, view: 'event', state: 'awaiting_confirmation', title: `Meet ${chat}`,
  startAt: '2030-10-27T03:00:00Z', endAt: '2030-10-27T03:30:00Z', unresolvedFields: [], options: [],
  participants: [
    { participantId: 'acct_peer', displayName: 'Synthetic Peer', organizer: true, rsvp: 'yes' },
    { participantId: 'acct_me', displayName: 'Me', organizer: false, rsvp: 'pending' },
  ],
});

const words = 'the plan for the weekend still needs a time that works for everyone in the chat'.split(' ');
function history(chat: string): Message[] {
  const messages: Message[] = Array.from({ length: 40 }, (_, index) => {
    const own = index % 3 === 0;
    return {
      id: `${chat}-${index}`, role: own ? 'user' : 'person', isOwnMessage: own, senderType: 'human',
      sender: own ? 'Me' : 'Synthetic Peer', time: '10:00',
      text: `${chat} ${index}: ${words.slice(0, 3 + ((index * 7) % words.length)).join(' ')}`,
    };
  });
  messages.push({
    id: `${chat}-plan`, role: 'person', isOwnMessage: false, senderType: 'human', sender: 'System',
    senderProfileImageUrl: KORDI_SYSTEM_AVATAR_URL, showSenderMeta: true, messageKind: 'system-notice',
    time: '10:01', text: 'Does Sunday evening work?', planCard: planCard(chat),
  });
  return messages;
}
const chats = { first: history('first'), second: history('second') };

function Preview() {
  const [chat, setChat] = useState<keyof typeof chats | null>('first');
  const items = chat ? chats[chat] : [];
  return <main className="kordi-app" style={{ height: 680, width: 820, display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', gap: 8 }}>
      <button onClick={() => setChat('first')}>Open first chat</button>
      <button onClick={() => setChat('second')}>Open second chat</button>
      <button onClick={() => setChat(null)}>Leave chats</button>
    </div>
    {chat ? <VirtualTranscript key="transcript" items={items} sessionKey={chat} getItemKey={message => message.id ?? ''}
      estimateSize={message => estimateTranscriptMessageHeight(message)}
      scrollClassName="app-chat-canvas" scrollStyle={{ height: 600, padding: '20px 20px 4px' }} gap={0}
      renderItem={message => <MessageBubble msg={message} />} /> : <div style={{ height: 600 }}>Contacts</div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
