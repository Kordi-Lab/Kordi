import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withLocalExecutionProgress } from '../src/features/chat/localExecutionProgress';
import { localRuntimeProgressForCanonicalPlaceholder } from '../src/features/canonical/localRuntimeProgress';
import { agentTurnHasStarted, canDisplayAgentTurn } from '../src/features/chat/agentProcessingVisibility';
import { LiveChatTurnCard, liveTurnSnapshotKey } from '../src/kordi-app/components/transcriptLiveTurns';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

const native: DesktopChatTurnSnapshot = {id:'00000000-0000-4000-8000-000000000001',sessionId:'chat',prompt:'Read the previous image',
  status:'preparing',message:'Preparing response…',assistantText:'',thinkingText:'',tools:[],completed:false,succeeded:false,replyToMessageId:'request'};
const pending: DesktopChatTurnSnapshot = {...native,id:'collaboration-live-turn:request',status:'processing',
  pendingCollaborationAgentRequest:{conversationId:'chat',requestId:'request'}};

test('a stop handle does not hide genuine local preparation after a cloud placeholder merge', () => {
  const presented = withLocalExecutionProgress(native,pending);
  assert.equal(agentTurnHasStarted(pending),false);
  assert.equal(agentTurnHasStarted(presented),true);
  assert.deepEqual(presented.pendingCollaborationAgentRequest,pending.pendingCollaborationAgentRequest);
  assert.notEqual(liveTurnSnapshotKey(presented),liveTurnSnapshotKey(pending));
  assert.match(renderToStaticMarkup(createElement(LiveChatTurnCard,{turn:presented})),/app-agent-waiting-wave/);
  assert.match(renderToStaticMarkup(createElement(LiveChatTurnCard,{turn:pending})),/app-agent-waiting-wave/);
});

test('optimistic, queued, and projected cloud states cannot establish local execution', () => {
  for (const turn of [{...native,status:'starting'},{...native,status:'queued'},
    {...native,id:'cloud-agent-execution:request'},{...native,completed:true},
    {...native,pendingCollaborationAgentRequest:pending.pendingCollaborationAgentRequest}]) {
    assert.equal(withLocalExecutionProgress(turn,pending),pending);
  }
  const presented=withLocalExecutionProgress(native,pending);
  const request:Message={id:'request',role:'user',text:'Question',time:'Now',statusChips:['sending']};
  assert.equal(canDisplayAgentTurn(presented,[request]),false);
  assert.equal(canDisplayAgentTurn(presented,[{...request,statusChips:['sent']}]),true);
});

test('canonical rows retain local execution evidence and their existing cancellation target', () => {
  const base:Message={id:'canonical',role:'owned-agent',text:'',time:'Now',turn:pending};
  const local:Message={...base,id:'runtime',turn:native};
  const merged=localRuntimeProgressForCanonicalPlaceholder(base,local);
  assert.equal(merged.id,'canonical');
  assert.equal(merged.turn?.localExecutionStarted,true);
  assert.equal(merged.turn?.status,'preparing');
  assert.deepEqual(merged.turn?.pendingCollaborationAgentRequest,pending.pendingCollaborationAgentRequest);
});
