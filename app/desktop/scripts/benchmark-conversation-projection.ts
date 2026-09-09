import { performance } from 'node:perf_hooks';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { createCollaborationConversationMapper } from '../src/features/collaboration/conversationProjectionCache';
import { buildScaleCollaborationConversation } from '../tests/fixtures/chatScale';

const map = process.argv.includes('--uncached')
  ? mapCollaborationConversationToViewModel
  : createCollaborationConversationMapper();
const source = buildScaleCollaborationConversation();
const conversations = Array.from({ length: 100 }, (_, i) => ({
  ...source, id: `fixture-conversation-${i}`, messages: source.messages.slice(0, 50),
}));
const now = Date.now();
let previous = conversations.map(conversation => map(conversation, undefined, 'Kordi', now));
const samples: number[] = [];
let changedConversations = 0;
for (let run = 0; run < 6; run++) {
  conversations[0] = { ...conversations[0], messages: [...conversations[0].messages, {
    id: `appended-${run}`, direction: 'outbound', sender: 'Me', text: 'Synthetic send',
    timeLabel: '12:00', timestampMs: now, deliveryState: 'sending',
  }] };
  const start = performance.now();
  const next = conversations.map(conversation => map(conversation, undefined, 'Kordi', now));
  samples.push(performance.now() - start);
  changedConversations = next.filter((conversation, index) => conversation !== previous[index]).length;
  previous = next;
}
process.stdout.write(JSON.stringify({ conversations: conversations.length, messagesPerChat: 50, remappedConversations: changedConversations, medianMs: +samples.slice(1).sort((a,b)=>a-b)[2].toFixed(3) }) + '\n');
