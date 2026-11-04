import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { forwardMessageSourceFromMessage } from '../../src/features/chat/messageActionMetadata';
import { createForwardedMessageDraft } from '../../src/features/chat/messageForwarding';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// Isolated regression fixture; synthetic content, no backend or native clients.
document.body.className = 'kordi-app theme-light';
const longText = '## Original answer\n\n**Important**: @all remains display text.\n\n- [x] Checked\n- Plain item\n\n' + Array.from({ length: 20 }, (_, index) => `Paragraph ${index + 1}: An intact copied answer remains readable after its source disappears.`).join('\n\n') + '\n\n```ts\nconst complete = true;\n```\n\n[Reference](https://example.com)\n\nFINAL SENTINEL';
function forwarded(id: string, text: string, comment = ''): Message {
  const original: Message = { id: `source-${id}`, role: 'owned-agent', sender: 'Synthetic Agent', text, time: '09:00' };
  const draft = createForwardedMessageDraft({ source: forwardMessageSourceFromMessage(original, 'source-session')!, caption: comment, destinationSessionId: 'target-session' });
  return { ...original, id, role: 'person', sender: 'Synthetic Forwarder', text: draft.text, messageAction: draft.messageAction };
}
const messages = [forwarded('short-forward', '**Short** answer'), forwarded('long-forward', longText, 'Review this copy'), { id: 'after', role: 'person', sender: 'Synthetic Person', text: 'Following message', time: '09:03' } satisfies Message];
function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column', maxWidth: 800, margin: 'auto', padding: 20 }}>
    <p>Offline synthetic forwarding regression</p>
    <VirtualTranscript items={messages} sessionKey="forward-regression" getItemKey={message => message.id!} estimateSize={() => 200}
      scrollRef={ref} scrollStyle={{ flex: 1, minHeight: 0 }}
      renderItem={message => <MessageBubble msg={message} onForwardMessage={() => {}} onOpenSenderProfile={() => { throw new Error('A copied mention must stay inert'); }} />} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
