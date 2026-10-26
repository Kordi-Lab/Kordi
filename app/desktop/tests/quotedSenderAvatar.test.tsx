import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act } from 'react';

import { setMessageLayout } from '../src/app/messageLayoutPreference';
import { buildReplyAttribution } from '../src/features/chat/replyAttribution';
import { sourceQuoteAvatar, withKnownSourceAvatar } from '../src/features/chat/sourceMessageAvatar';
import { setLocalProfileAvatarSeed } from '../src/kordi-app/components/IdentityAvatar';
import { setActiveLocalProfileIdentity } from '../src/kordi-app/components/localProfileIdentity';
import { SourceMessageQuote } from '../src/kordi-app/components/transcriptReplyAttribution';
import type { Message, MessageSourceReference } from '../src/kordi-app/types';
import { generatedAvatarSeedForLabel, isValidAvatarSeed } from '../src/lib/identityLabels';
import { humanRequest, turn } from './helpers/replyAttributionFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const local = { selfDisplayName: 'Main Test A', profileAvatarSeed: 'acct_me_seed', agentAvatarSeed: 'default-agent-acct_me' };

function agentReply(overrides: Partial<Message> = {}): Message {
  return {
    id: 'reply',
    role: 'external-agent',
    sender: 'KordiMainTestB',
    senderType: 'agent',
    text: '',
    time: '10:01',
    replyToMessageId: 'request',
    turn: turn({ assistantText: 'hi', replyToMessageId: 'request' }),
    ...overrides,
  };
}

test('generated fallback seeds are always accepted by the avatar server', () => {
  for (const label of ['Main Test A', 'human:Main Test A', '\u5f20\u4f1f', '', '  ', 'a'.repeat(300)]) {
    for (const kind of ['human', 'agent'] as const) {
      const seed = generatedAvatarSeedForLabel(kind, label);
      assert.ok(isValidAvatarSeed(seed), `${kind} ${label} -> ${seed}`);
      assert.equal(seed, generatedAvatarSeedForLabel(kind, label));
    }
  }
  assert.notEqual(generatedAvatarSeedForLabel('human', '\u5f20\u4f1f'), generatedAvatarSeedForLabel('human', '\u674e\u5a1c'));
});

test('an agent reply quotes its trigger with the trigger row avatar', () => {
  const request = humanRequest({
    id: 'request',
    sender: 'Peer Person',
    isOwnMessage: false,
    role: 'person',
    senderAvatarSeed: 'acct_peer_seed',
    senderProfileImageUrl: 'https://images.test/peer.png',
  });
  const quote = buildReplyAttribution([request, agentReply()]).messages[1].sourceMessage;
  assert.ok(quote);
  assert.deepEqual(sourceQuoteAvatar(quote, local), {
    kind: 'human', seed: 'acct_peer_seed', imageUrl: 'https://images.test/peer.png', isSelf: false,
  });
});

test('own and own-agent quotes use the local profile and local agent avatars', () => {
  const ownQuote = buildReplyAttribution([humanRequest({ id: 'request', sender: 'Me' }), agentReply()]).messages[1].sourceMessage;
  assert.ok(ownQuote);
  assert.deepEqual(sourceQuoteAvatar(ownQuote, local), { kind: 'human', seed: 'acct_me_seed', imageUrl: null, isSelf: true });
  assert.equal(sourceQuoteAvatar({ messageId: 'm', senderLabel: 'You', text: 'x' }, local).seed, 'acct_me_seed');
  assert.equal(sourceQuoteAvatar({ messageId: 'm', senderLabel: 'Main Test A', text: 'x' }, local).isSelf, true);
  assert.deepEqual(
    sourceQuoteAvatar({ messageId: 'm', senderLabel: 'My Kordi', senderKind: 'agent', senderIsSelf: true, text: 'x' }, local),
    { kind: 'agent', seed: 'default-agent-acct_me', imageUrl: null, isSelf: false },
  );
});

test('a stored quote without avatar data borrows it from the loaded source row', () => {
  const stored: MessageSourceReference = { messageId: 'request', senderLabel: 'Peer Person', text: 'hello' };
  const known: MessageSourceReference = { ...stored, senderKind: 'human', senderAvatarSeed: 'acct_peer_seed', senderIsSelf: false };
  assert.equal(withKnownSourceAvatar(stored, known).senderAvatarSeed, 'acct_peer_seed');
  assert.equal(withKnownSourceAvatar(stored, { ...known, messageId: 'other' }), stored);

  const request = humanRequest({ id: 'request', sender: 'Peer Person', isOwnMessage: false, role: 'person', senderAvatarSeed: 'acct_peer_seed' });
  const humanReply = humanRequest({ id: 'quote', replyToMessageId: 'request', sourceMessage: stored });
  const linked = buildReplyAttribution([request, humanReply]).messages[1].sourceMessage;
  assert.equal(linked?.senderAvatarSeed, 'acct_peer_seed');
  assert.equal(linked?.text, 'hello');
});

test('unknown or invalid quote seeds fall back to a valid generated seed', () => {
  for (const senderAvatarSeed of [undefined, 'human:Main Test B', 'cloud-agent:acct_b']) {
    const avatar = sourceQuoteAvatar({ messageId: 'm', senderLabel: 'Main Test B', senderAvatarSeed, text: 'x' }, local);
    assert.ok(isValidAvatarSeed(avatar.seed), avatar.seed);
  }
});

test('the thread quote line renders the quoted sender avatar instead of an invalid label seed', async () => {
  await withJsdomRoot(async (mount) => {
    try {
      await act(async () => {
        setMessageLayout('threads');
        setActiveLocalProfileIdentity({ avatarSeed: 'acct_me_seed', displayName: 'Main Test A', profileImageUrl: null });
        setLocalProfileAvatarSeed('acct_me_seed');
      });
      const peer = await mount(<SourceMessageQuote sourceMessage={{
        messageId: 'm', senderLabel: 'Peer Person', senderKind: 'human', senderAvatarSeed: 'acct_peer_seed', text: 'hi',
      }} />);
      assert.match(peer.querySelector('img')?.getAttribute('src') ?? '', /preview\/lorelei\/acct_peer_seed\.png$/);

      const self = await mount(<SourceMessageQuote sourceMessage={{ messageId: 'm', senderLabel: 'You', text: 'hi' }} />);
      assert.match(self.querySelector('img')?.getAttribute('src') ?? '', /preview\/lorelei\/acct_me_seed\.png$/);

      const unknown = await mount(<SourceMessageQuote sourceMessage={{ messageId: 'm', senderLabel: 'Main Test B', text: 'hi' }} />);
      const src = unknown.querySelector('img')?.getAttribute('src') ?? '';
      assert.match(src, /preview\/lorelei\/human-main-test-b-[a-z0-9]+\.png$/);
    } finally {
      setMessageLayout('chat');
      setActiveLocalProfileIdentity({ avatarSeed: null, displayName: null, profileImageUrl: null });
    }
  });
});


test('wire and legacy desktop quote references retain the sender avatar and navigate to the loaded row', () => {
  const wireId = '10000000-0000-4000-8000-000000000001';
  const displayedId = `collaboration-message:this-viewer:${wireId}`;
  const original = humanRequest({
    id: displayedId, role: 'person', isOwnMessage: false, sender: 'Peer Person',
    reactionTargetMessageId: wireId, senderAvatarSeed: 'acct_peer_seed',
    senderProfileImageUrl: 'https://images.test/peer.png',
  });
  for (const reference of [wireId, `collaboration-message:another-viewer:${wireId}`]) {
    const reply = humanRequest({
      id: 'reply', replyToMessageId: reference,
      sourceMessage: { messageId: reference, senderLabel: 'Peer Person', text: 'Saved preview' },
    });
    const messages = buildReplyAttribution([original, reply]).messages;
    assert.equal(messages[1].replyToMessageId, displayedId);
    assert.equal(messages[1].sourceMessage?.messageId, displayedId);
    assert.equal(messages[1].sourceMessage?.text, 'Saved preview');
    assert.equal(messages[1].sourceMessage?.senderProfileImageUrl, original.senderProfileImageUrl);
    assert.equal(messages[0].replySummary?.replyCount, 1);
  }
  const unknown = 'collaboration-message:another-viewer:20000000-0000-4000-8000-000000000002';
  const reply = humanRequest({ id: 'unknown-reply', replyToMessageId: unknown,
    sourceMessage: { messageId: unknown, senderLabel: 'Peer Person', text: original.text } });
  assert.equal(buildReplyAttribution([original, reply]).messages[1].sourceMessage?.senderProfileImageUrl, undefined);
});
