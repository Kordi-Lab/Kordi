import { createRoot } from 'react-dom/client';
import { mapCanonicalMessage } from '../../src/features/canonical/readModel/messageMapping';
import { mapCollaborationConversationToViewModel } from '../../src/features/collaboration/transcript';
import { conversation, host } from '../helpers/collaborationTranscriptFixtures';
import { KORDI_SYSTEM_AVATAR_URL } from '../../src/features/systemAgent/systemAgentIdentity';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '../../src/kordi-app/types';
import type { MessagePlanCard } from '../../src/kordi-app/types/message';
import '../../src/index.css';

// Server "Grounding" notices mapped through the real read model, next to a plan agent reply (also System),
// then a direct-chat plan card the viewer organized, mapped through the direct-chat path.
const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.body.className = `kordi-app theme-${theme}`;
document.documentElement.classList.toggle('dark', theme === 'dark');
// The stored account id keeps the System agent's old name.
const systemAgent = { id: 'human:acct_kordi_pip', kind: 'human', displayName: 'System', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_kordi_pip',
  humanId: 'acct_kordi_pip', profileImageUrl: KORDI_SYSTEM_AVATAR_URL, createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
const maya = { id: 'human:acct_preview_maya', kind: 'human', displayName: 'Maya Chen', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_preview_maya',
  humanId: 'acct_preview_maya', avatarKey: 'maya-preview', createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
const identities = new Map([[systemAgent.id, systemAgent], [maya.id, maya]]);
const row = (id: string, sender: CanonicalIdentity, messageKind: string, text: string, minute: number): CanonicalSessionMessage => ({
  id, sessionId: 'session:group:preview', senderIdentityId: sender.id, senderRole: 'person', messageKind, contentText: text,
  content: { schema: 1, blocks: [{ type: 'text', text }] }, status: 'received', sequenceNum: minute, createdAtMs: Date.UTC(2026, 9, 21, 9, minute), updatedAtMs: 1,
  sourceTransport: 'cloud-group',
});
const messages = [
  row('intro', systemAgent, 'system-notice', 'This group is for planning the offsite.\nMaya and Alex both work on the mobile app and are in Lisbon this month.', 1),
  row('joined', systemAgent, 'system-notice', 'Jordan Lee joined. Jordan leads design and has run two offsites before.', 2),
  row('maya', maya, 'text', 'Great, welcome Jordan!', 3),
  row('system-agent', systemAgent, 'text', 'Here is a first draft of the plan.', 4),
].map((message) => mapCanonicalMessage(message, identities, 'human:me')).filter((message): message is Message => Boolean(message));
const planCard: MessagePlanCard = {
  eventId: 'preview-coffee', revision: 2, view: 'event', state: 'polling', title: 'Coffee with Maya', unresolvedFields: [], options: [],
  participants: [
    { participantId: 'acct_preview_me', displayName: 'Me', organizer: true, rsvp: 'yes' },
    { participantId: 'acct_preview_maya', displayName: 'Maya Chen', organizer: false, rsvp: 'pending' },
  ],
};
const direct = mapCollaborationConversationToViewModel(conversation({
  peerDisplayName: 'Maya Chen', title: 'Maya Chen',
  messages: [
    { id: 'direct-hi', direction: 'outbound', sender: 'Me', text: 'Coffee this week?', timeLabel: '09:05', timestampMs: Date.UTC(2026, 9, 21, 9, 5), messageKind: 'text' },
    { id: 'direct-plan', direction: 'outbound', sender: 'Me', text: '', timeLabel: '09:06', timestampMs: Date.UTC(2026, 9, 21, 9, 6), deliveryState: 'read', messageKind: 'system-notice', planCard },
  ],
}), host(), 'My Kordi').messages;
messages.push(...direct);

createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 720, margin: '0 auto', padding: 24, minHeight: '100dvh', background: 'var(--app-chat-background, var(--background))' }}>
    {messages.map((message) => <MessageBubble key={message.id} msg={message} onOpenSenderProfile={() => {}} />)}
  </main>,
);
