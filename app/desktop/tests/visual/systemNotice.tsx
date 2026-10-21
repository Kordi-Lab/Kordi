import { createRoot } from 'react-dom/client';
import { mapCanonicalMessage } from '../../src/features/canonical/readModel/messageMapping';
import { KORDI_PIP_AVATAR_URL } from '../../src/features/pip/pipIdentity';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// Server "Grounding" notices mapped through the real read model, next to an ordinary PiP reply.
const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.body.className = `kordi-app theme-${theme}`;
document.documentElement.classList.toggle('dark', theme === 'dark');
const pip = { id: 'human:acct_kordi_pip', kind: 'human', displayName: 'PiP', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_kordi_pip',
  humanId: 'acct_kordi_pip', profileImageUrl: KORDI_PIP_AVATAR_URL, createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
const maya = { id: 'human:acct_preview_maya', kind: 'human', displayName: 'Maya Chen', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_preview_maya',
  humanId: 'acct_preview_maya', avatarKey: 'maya-preview', createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
const identities = new Map([[pip.id, pip], [maya.id, maya]]);
const row = (id: string, sender: CanonicalIdentity, messageKind: string, text: string, minute: number): CanonicalSessionMessage => ({
  id, sessionId: 'session:group:preview', senderIdentityId: sender.id, senderRole: 'person', messageKind, contentText: text,
  content: { schema: 1, blocks: [{ type: 'text', text }] }, status: 'received', sequenceNum: minute, createdAtMs: Date.UTC(2026, 9, 21, 9, minute), updatedAtMs: 1,
  sourceTransport: 'cloud-group',
});
const messages = [
  row('intro', pip, 'system-notice', 'This group is for planning the offsite.\nMaya and Alex both work on the mobile app and are in Lisbon this month.', 1),
  row('joined', pip, 'system-notice', 'Jordan Lee joined. Jordan leads design and has run two offsites before.', 2),
  row('maya', maya, 'text', 'Great, welcome Jordan!', 3),
  row('pip', pip, 'text', 'Here is a first draft of the plan.', 4),
].map((message) => mapCanonicalMessage(message, identities, 'human:me')).filter((message): message is Message => Boolean(message));

createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 720, margin: '0 auto', padding: 24, minHeight: '100dvh', background: 'var(--app-chat-background, var(--background))' }}>
    {messages.map((message) => <MessageBubble key={message.id} msg={message} onOpenSenderProfile={() => {}} />)}
  </main>,
);
