import './previewChatTheme';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { DesktopChatTurnSnapshot, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// Production MessageBubble rows for a running reply's Stop and a finished reply's Fork. Synthetic content.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.body.className = `kordi-app theme-${theme}`;
document.documentElement.classList.toggle('dark', theme === 'dark');
document.body.style.background = 'var(--utility-background)';

const now = Date.now();
function turn(id: string, overrides: Partial<DesktopChatTurnSnapshot>): DesktopChatTurnSnapshot {
  return {
    id, sessionId: 'running-controls', prompt: '', status: 'writing', message: '', thinkingText: '', tools: [],
    assistantText: 'Checking the release notes for the launch build', completed: false, succeeded: false, error: null,
    startedAtMs: now - 2_000, sourceMessage: { messageId: 'request', senderLabel: 'You', senderIsSelf: true, text: 'Check the notes' },
    ...overrides,
  };
}
function reply(id: string, snapshot: DesktopChatTurnSnapshot, extra: Partial<Message> = {}): Message {
  return { id, entryId: `entry-${id}`, role: 'owned-agent', senderType: 'agent', sender: 'Atlas', senderOwnerName: 'You', text: '', time: '09:42', turn: snapshot, ...extra };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <section data-row={label} style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: 12, padding: '14px 0', borderTop: '1px solid color-mix(in oklab, var(--utility-muted-text) 14%, transparent)' }}>
    <div style={{ fontSize: 11, color: 'var(--utility-muted-text)', paddingTop: 4 }}>{label}</div>
    <div>{children}</div>
  </section>;
}

function Preview() {
  const [action, setAction] = useState('');
  const [stoppingTurn, setStoppingTurn] = useState(() => turn('stopping', {}));
  const running = reply('running', turn('running', {}));
  const stopping = reply('stopping', stoppingTurn);
  const stopped = reply('stopped', turn('stopped', {
    status: 'cancelled', completed: true, startedAtMs: now - 6_000, completedAtMs: now, ending: 'stopped',
    tools: [{ id: 'read-notes', name: 'read', status: 'completed', arguments: '{"path":"notes/launch.md"}', liveOutput: '', isError: false }],
    assistantText: 'I checked the first two release notes before you stopped me.',
  }));
  const finished = reply('finished', turn('finished', {
    status: 'complete', completed: true, succeeded: true, startedAtMs: now - 14_000, completedAtMs: now,
    assistantText: 'The launch build notes are ready.',
  }));
  const fork = (entryId: string) => setAction(`fork:${entryId}`);
  return <main style={{ maxWidth: 760, margin: '0 auto', padding: 24, color: 'var(--utility-foreground)' }}>
    <output data-last-action={action} style={{ display: 'block', minHeight: 18, fontSize: 11, color: 'var(--utility-muted-text)' }}>{action}</output>
    <Row label="Running"><MessageBubble msg={running} onForkMessage={fork} onStopActiveTurn={() => { setAction('stop:running'); }} /></Row>
    <Row label="Stopping"><MessageBubble msg={stopping} onForkMessage={fork} onStopActiveTurn={() => {
      setAction('stop:stopping');
      setStoppingTurn(current => ({ ...current, status: 'cancelling' }));
      return new Promise<boolean>(() => {});
    }} /></Row>
    <Row label="Stopped"><MessageBubble msg={stopped} onForkMessage={fork} onStopActiveTurn={() => {}} /></Row>
    <Row label="Finished"><MessageBubble msg={finished} onForkMessage={fork} onStopActiveTurn={() => {}} /></Row>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
