import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { MessageForwardDialog } from '../../src/pages/MessageForwardDialog';
import { buildForwardDestinations } from '../../src/features/chat/messageForwarding';
import { conversation, contact } from '../helpers/workspaceSidebarParticipantSpacesFixtures';

// Actual production component with synthetic data and a simulated transport.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.body.className = `kordi-app theme-${theme}`;
document.documentElement.classList.toggle('dark', theme === 'dark');
const now = Date.now();
const destinations = buildForwardDestinations([
  conversation({ id: 'session:group:product', canonicalSessionId: 'session:group:product', name: 'General', type: 'group', participantSpaceId: 'session:group:product', metadata: { customName: 'Product team', groupSpaceId: 'session:group:product' }, _updatedAtMs: now - 120000, updatedAtLabel: '2m ago' }),
  conversation({ id: 'session:direct-person:maya', canonicalSessionId: 'session:direct-person:maya', name: 'Maya Chen', _updatedAtMs: now - 480000, updatedAtLabel: '8m ago', canonicalParticipants: [{ id: 'maya', kind: 'human', name: 'Maya Chen', role: 'person', kordiId: '123456789' }] }),
  conversation({ id: 'session:self-agent:review', canonicalSessionId: 'session:self-agent:review', name: 'Onboarding review', type: 'owned-agent', participantSpaceId: null, canonicalParticipants: [{ id: 'agent', kind: 'agent', name: 'Research assistant', role: 'agent' }], metadata: { parentGroupSpaceId: 'session:group:product' }, _updatedAtMs: now - 1440000, updatedAtLabel: '24m ago' }),
  conversation({ id: 'session:group:research', canonicalSessionId: 'session:group:research', name: 'General', type: 'group', participantSpaceId: 'session:group:research', metadata: { customName: 'Research circle', groupSpaceId: 'session:group:research' }, _updatedAtMs: now - 2700000, updatedAtLabel: '45m ago' }),
], undefined, [contact({ id: 'cloud:avery', name: 'Avery Morgan', entityType: 'user', sourceHostId: 'cloud', sourceParticipantId: 'avery', contactStatus: 'accepted', subtitle: '@987654321' })]);
const source = { sourceSessionId: 'preview-source', sourceMessageId: 'preview-message', senderLabel: 'You', textPreview: 'Let’s make the destination easier to find before we share this.', attachmentCount: 0, attachments: [], attachmentOnly: false };
function Preview() {
  const [open, setOpen] = useState(true);
  return <main className="p-6"><p>Implementation preview · Sample conversations · Nothing is sent</p><button className="forward-primary mt-4" onClick={() => setOpen(true)}>Open forward dialog</button>{open ? <MessageForwardDialog sources={params.has('batch') ? [source, { ...source, sourceMessageId: 'preview-second' }] : [source]} destinations={destinations} sourceLabel="Design team › Forwarding review" onClose={() => setOpen(false)} onForward={async () => { await new Promise((resolve) => setTimeout(resolve, 500)); if (params.has('error')) throw new Error('Couldn’t finish forwarding. Try again.'); }} /> : null}</main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
