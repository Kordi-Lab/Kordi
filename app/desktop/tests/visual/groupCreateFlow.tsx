import './previewChatTheme';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalMessageRole } from '../../src/features/canonical/readModel/messageRole';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import { DissolveDialog } from '../../src/pages/DissolveDialog';
import { SessionContextMenu, type SessionActionTarget } from '../../src/pages/SessionActionOverlays';
import type { CanonicalSessionMessage, Message } from '../../src/kordi-app/types';

// Synthetic data only. ?theme=light|dark, ?mode=transcript|channel
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const mode = params.get('mode') === 'channel' ? 'channel' : 'transcript';
document.body.className = `kordi-app theme-${theme}`;
document.documentElement.classList.toggle('dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

// The server's "created the group" notice, as the canonical read model receives it.
const createdNotice = {
  id: 'msg:created', sessionId: 'session:group:launch', senderIdentityId: 'human:ava', senderRole: 'person',
  messageKind: 'system-notice', contentText: 'Ava Lee created the group',
  content: { group_event: { type: 'group.created', actor_account_id: 'acct_ava', actor_display_name: 'Ava Lee' } },
  status: 'complete', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1,
} as CanonicalSessionMessage;

const messages: Message[] = [
  { id: 'msg:created', role: canonicalMessageRole(createdNotice), senderType: 'human', sender: 'System', text: createdNotice.contentText, time: '09:30' },
  { id: 'msg:joined', role: 'system', senderType: 'human', sender: 'System', text: 'Ben Ortiz joined the group, invited by Ava Lee.', time: '09:31' },
  { id: 'msg:hello', role: 'person', senderType: 'human', sender: 'Ava Lee', text: 'Welcome! The checklist is pinned.', time: '09:32', showSenderMeta: true },
];

function ChannelPreview() {
  const [menuOpen, setMenuOpen] = useState(true);
  const [target, setTarget] = useState<(SessionActionTarget & { groupSpaceId: string }) | null>(null);
  const [done, setDone] = useState('');
  return <main style={{ height: '100dvh', background: 'var(--app-page-bg)', color: 'var(--utility-foreground)', padding: 24 }}>
    <p data-testid="done">{done}</p>
    {menuOpen ? <SessionContextMenu
      target={{ sessionId: 'session:group:qa', sessionName: '# QA', x: 80, y: 60, dissolvableChannel: { groupSpaceId: 'session:group:launch' } }}
      onClose={() => setMenuOpen(false)} onRename={() => {}} onArchive={() => {}} onRestore={() => {}}
      onSetPinned={() => {}} onSetMuted={() => {}} onSetUnread={() => {}} onDelete={() => {}}
      onDissolveChannel={setTarget}
    /> : null}
    {target ? <DissolveDialog scope="channel" name="QA" anchorRect={target.anchorRect}
      onCancel={() => setTarget(null)} onConfirm={async () => { setDone(`dissolved:${target.groupSpaceId}:${target.sessionId}`); }} /> : null}
  </main>;
}

function TranscriptPreview() {
  return <main style={{ maxWidth: 720, margin: '0 auto', padding: 24, minHeight: '100dvh', background: 'var(--app-page-bg)' }}>
    {messages.map((message) => <MessageBubble key={message.id} msg={message} />)}
  </main>;
}

createRoot(document.getElementById('root')!).render(mode === 'channel' ? <ChannelPreview /> : <TranscriptPreview />);
document.body.dataset.visualReady = 'true';
