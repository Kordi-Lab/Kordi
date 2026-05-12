import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount } from '../src/features/cloud/authClient';
import {
  CLOUD_AGENT_RUNTIME_SESSION_PREFIX,
  buildCloudAgentPromptWithSharedContext,
  cloudMessageMentionsFirstPersonAgent,
  cloudMessageMentionsLocalAgent,
  cloudMessageMentionsNamedAgent,
  encodeCloudAgentCancel,
  encodeCloudAgentResponse,
  isCloudAgentControlMessage,
  isCloudAgentRuntimeSessionId,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
  promptTextForCloudAgentMention,
} from '../src/features/cloud/cloudAgentMessages';
import type { CloudMessage } from '../src/features/cloud/authClient';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Shuyheres',
  primaryEmail: 'shu@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

test('cloud agent runtime session ids are isolated from visible local chat sessions', () => {
  assert.equal(isCloudAgentRuntimeSessionId(`${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}acct_me:acct_peer`), true);
  assert.equal(isCloudAgentRuntimeSessionId('session-local'), false);
});

test('cloud agent mention matching recognizes local Kordi labels', () => {
  assert.equal(cloudMessageMentionsLocalAgent('@Shuyheres who are you?', account), false);
  assert.equal(cloudMessageMentionsLocalAgent('@ShuyheresKordi who are you?', account), true);
  assert.equal(cloudMessageMentionsLocalAgent('@ShuyheressKordi who are you?', account), true);
  assert.equal(cloudMessageMentionsLocalAgent('@MyShuyheres who are you?', account), false);
  assert.equal(cloudMessageMentionsLocalAgent('@MyShuyheresKordi who are you?', account), true);
  assert.equal(cloudMessageMentionsLocalAgent('@Kordi who are you?', account), true);
  assert.equal(cloudMessageMentionsLocalAgent('@OtherKordi who are you?', account), false);
  assert.equal(cloudMessageMentionsLocalAgent('@MyKordi who are you?', account, { allowFirstPerson: false }), false);
  assert.equal(cloudMessageMentionsLocalAgent('@Kordi who are you?', account, { allowFirstPerson: false }), false);
  assert.equal(cloudMessageMentionsLocalAgent('@ShuyheresKordi who are you?', account, { allowFirstPerson: false }), true);
});

test('cloud first-person agent mentions are sender-owned, not recipient-owned', () => {
  assert.equal(cloudMessageMentionsFirstPersonAgent('@MyKordi what is agentic?'), true);
  assert.equal(cloudMessageMentionsFirstPersonAgent('@Kordi what is agentic?'), true);
  assert.equal(cloudMessageMentionsFirstPersonAgent('@ShuyheresKordi what is agentic?'), false);
});

test('cloud named agent mention matching recognizes remote Kordi labels', () => {
  assert.equal(cloudMessageMentionsNamedAgent('@PeerPersonKordi who are you?', 'Peer Person'), true);
  assert.equal(cloudMessageMentionsNamedAgent('@PeerPersonsKordi who are you?', 'Peer Person'), true);
  assert.equal(cloudMessageMentionsNamedAgent('@PeerPersonsKordi who are you?', "Peer Person's Kordi"), true);
  assert.equal(cloudMessageMentionsNamedAgent('@OtherKordi who are you?', 'Peer Person'), false);
});

test('cloud agent mention prompt strips mention token', () => {
  assert.equal(promptTextForCloudAgentMention('@ShuyheresKordi who are you?'), 'who are you?');
});

test('cloud agent response envelope round trips without exposing metadata text', () => {
  const encoded = encodeCloudAgentResponse({ requestId: 'msg_1', text: 'I am Kordi.' });
  assert.notEqual(encoded.includes('I am Kordi.'), true);
  assert.deepEqual(parseCloudAgentResponse(encoded), {
    kind: 'agent-response',
    requestId: 'msg_1',
    text: 'I am Kordi.',
  });
  assert.equal(parseCloudAgentResponse('normal text'), null);
});

test('cloud agent prompt includes the shared human plus agent cloud context window', () => {
  const request: CloudMessage = {
    messageId: 'msg_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyKordi can you see that greeting?',
    createdAt: '2026-05-11T10:03:00Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
  };
  const prompt = buildCloudAgentPromptWithSharedContext({
    localAccountId: 'acct_me',
    localHumanName: 'Shuyhere',
    peerHumanName: 'Shuyheretest',
    localAgentName: 'My Kordi',
    peerAgentName: "Shuyheretest's Kordi",
    requestMessage: request,
    messages: [
      {
        ...request,
        messageId: 'msg_human_peer',
        fromAccountId: 'acct_peer',
        toAccountId: 'acct_me',
        body: 'Hi! Thanks for adding me.',
        createdAt: '2026-05-11T10:01:00Z',
        direction: 'incoming',
      },
      {
        ...request,
        messageId: 'msg_agent_peer',
        fromAccountId: 'acct_peer',
        toAccountId: 'acct_me',
        body: encodeCloudAgentResponse({ requestId: 'msg_remote_request', text: 'I can help.' }),
        createdAt: '2026-05-11T10:02:00Z',
        direction: 'incoming',
      },
      request,
    ],
  });

  assert.match(prompt, /Shared conversation:/);
  assert.match(prompt, /Shuyheretest: Hi! Thanks for adding me\./);
  assert.match(prompt, /Shuyheretest's Kordi: I can help\./);
  assert.match(prompt, /Current request from Shuyhere: can you see that greeting\?/);
});

test('cloud agent cancel envelope round trips and is treated as control metadata', () => {
  const encoded = encodeCloudAgentCancel({ requestId: 'msg_1' });
  assert.deepEqual(parseCloudAgentCancel(encoded), {
    kind: 'agent-cancel',
    requestId: 'msg_1',
  });
  assert.equal(isCloudAgentControlMessage(encoded), true);
  assert.equal(isCloudAgentControlMessage('normal text'), false);
});
