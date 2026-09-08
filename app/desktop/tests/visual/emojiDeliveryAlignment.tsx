import { createRoot } from 'react-dom/client';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

const messages: Message[] = ['😌', '😝', '😀'].flatMap(text => ['sending', 'sent', 'delivered', 'read', 'failed'].map(status => ({
  id: `${text}-${status}`, role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true,
  text, time: '12:00', statusChips: [status],
})));

createRoot(document.getElementById('root')!).render(
  <main className="kordi-app theme-dark" style={{ width: 420, padding: 24, display: 'block' }}>
    {messages.map(msg => <section key={msg.id}><MessageBubble msg={msg}/></section>)}
    <section className="reference-text"><MessageBubble msg={{ ...messages[0], id: 'reference', text: 'Alignment reference', statusChips: ['sent'] }}/></section>
  </main>,
);
