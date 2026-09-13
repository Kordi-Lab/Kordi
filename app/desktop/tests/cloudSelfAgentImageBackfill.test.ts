import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAuthClient } from '../src/features/cloud/authClient';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import type { ChatSyncConversation, ChatSyncMessage } from '../src/features/cloud/chatSyncTypes';
import { backfillLocalHistoryImages, missingImageCandidate } from '../src/features/cloud/cloudSelfAgentImageBackfill';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';

function wire(): ChatSyncMessage {
  return {id:'wire-backfill',client_message_id:cloudSelfAgentRequestClientMessageId('chat','local'),kind:'canonical-history-user',version:1,
    attachment_ids:[],deleted_at:null,edited_at:null,content:{canonical_history:{local_message_id:'local'}}} as unknown as ChatSyncMessage;
}

test('backfill is limited to untouched matching private history exports', () => {
  assert.equal(missingImageCandidate(wire(),'local'),true);
  for (const change of [{version:2},{deleted_at:'deleted'},{edited_at:'edited'},{attachment_ids:['existing']},{kind:'text'}]) {
    assert.equal(missingImageCandidate({...wire(),...change},'local'),false);
  }
  assert.equal(missingImageCandidate(wire(),'unrelated'),false);
});

test('automatic repair uses original message identity once and preserves unrelated messages', async () => {
  const calls: string[] = [];
  const client = { chat: { backfillMissingImages: async (_token: string, conversation: string, id: string, images: unknown) => {
    calls.push('repair'); assert.equal(conversation,'conversation');assert.equal(id,'wire-backfill');
    assert.deepEqual(images,[{attachmentId:'uploaded',name:'image.png'}]);
  } } } as unknown as CloudAuthClient;
  const state = {messages:[{id:'local',sessionId:'chat',senderRole:'user',contentText:'Caption',createdAtMs:1,
    content:{attachments:[{name:'image.png',kind:'image',localPath:'/tmp/synthetic.png'}]}}]} as unknown as CanonicalSessionState;
  const input = { accountId:'owner',token:'fixture',state,conversations:[{id:'conversation',kind:'ai',legacy_session_id:'chat'} as ChatSyncConversation],client,
    shouldContinue:()=>true,
    loadPage:async()=>({conversationId:'conversation',messages:[wire()],hasMore:false,nextAfterSequence:null}),
    upload:async()=>{calls.push('upload');return [{attachmentId:'uploaded',name:'image.png',kind:'image' as const}];},
  };
  assert.equal(await backfillLocalHistoryImages(input),true);
  assert.equal(await backfillLocalHistoryImages(input),false);
  assert.deepEqual(calls,['upload','repair']);
});
