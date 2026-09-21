import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '../../src/features/chat/VirtualTranscript';
import { estimateTranscriptMessageHeight } from '../../src/features/chat/transcriptHeightEstimate';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// Real message bubbles with the production height estimator. This is the shape
// the desktop transcript scrolls through, so it exposes the same measurement
// corrections that a long history performs while the user is scrolling.
const SAMPLE_TEXTS = [
  'Ok',
  'Sounds good, I will take a look.',
  'Can you check the deployment logs when you get a chance? I want to make sure the migration finished before we announce.',
  'Here is the plan:\n1. Ship the schema change\n2. Backfill the rows\n3. Verify the projection',
  'Thanks!',
  'I pushed a fix. The problem was that the estimate function ignored the grouping height, so the virtual list measured rows on every scroll and the corrections fought the gesture.',
  '```ts\nconst rows = items.map((item, index) => ({ item, index }));\nreturn rows;\n```',
  'Let me know.',
  'The rollout is complete. All 20 recipients acknowledged delivery, and the two that failed on the first attempt recovered on retry. I am monitoring the error rate for the next hour.',
];

function messages(): Message[] {
  return Array.from({ length: 240 }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 3 === 0 ? 'owned-agent' : 'person',
    sender: index % 3 === 0 ? 'Agent' : 'Person',
    text: SAMPLE_TEXTS[index % SAMPLE_TEXTS.length],
    time: '10:00',
  }));
}

function Stability() {
  const [items] = useState(messages);
  return <main style={{ height: 680, width: 800, display: 'flex', flexDirection: 'column' }}>
    <VirtualTranscript
      items={items}
      sessionKey="synthetic-history-stability"
      getItemKey={message => message.id!}
      estimateSize={message => estimateTranscriptMessageHeight(message)}
      scrollStyle={{ height: 600 }}
      renderItem={message => (
        <div data-message-id={message.id}>
          <MessageBubble msg={message} />
        </div>
      )}
    />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Stability />);
