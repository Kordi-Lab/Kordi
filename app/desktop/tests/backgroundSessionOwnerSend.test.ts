import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundSessionModelOptions, ownerMessageToAgent } from '../src/features/cloud/subsessionConversation';

const record = { ownerAccountId: 'owner', ownerDisplayName: 'Alex Morgan', agentDisplayName: 'Atlas', agentId: 'cloud-agent:owner' };

// "continue" in the owner's own background session used to be stored as a
// plain group message: the server runs the agent only for an explicit mention.
test('the owner asks their own agent without typing a mention', () => {
  const sent = ownerMessageToAgent('continue', [], record, 'owner');
  assert.equal(sent.text, '@AtlasAlexMorgan continue');
  assert.equal(sent.mentions.length, 1);
  const [mention] = sent.mentions;
  assert.equal(mention.targetKind, 'agent');
  assert.equal(mention.agentId, 'cloud-agent:owner');
  assert.equal(sent.text.slice(mention.startUtf16!, mention.startUtf16! + mention.lengthUtf16!), '@AtlasAlexMorgan');
});

test('other people and explicit mentions keep the shared mention rule', () => {
  assert.deepEqual(ownerMessageToAgent('continue', [], record, 'member'), { text: 'continue', mentions: [] });
  const personMention = [{ label: 'Maya', targetKind: 'person', startUtf16: 0, lengthUtf16: 5 }];
  assert.deepEqual(ownerMessageToAgent('@Maya what do you think', personMention, record, 'owner'),
    { text: '@Maya what do you think', mentions: personMention });
  assert.deepEqual(ownerMessageToAgent('continue', [], null, 'owner'), { text: 'continue', mentions: [] });
});

test('a background session offers only the models of its account', () => {
  const options = [
    { value: 'openai-codex/gpt-6-sol', label: 'gpt-6-sol', provider: 'openai-codex' },
    { value: 'openai-codex/gpt-6-mini', label: 'gpt-6-mini', provider: 'openai-codex' },
    { value: 'openai/gpt-6-sol', label: 'gpt-6-sol', provider: 'openai' },
    { value: 'anthropic/claude-test', label: 'claude-test', provider: 'anthropic' },
  ];
  assert.deepEqual(backgroundSessionModelOptions(options, { model: 'openai-codex/gpt-6-sol' }).map(option => option.value),
    ['openai-codex/gpt-6-sol', 'openai-codex/gpt-6-mini']);
  // The inherited model stays visible even when this Mac does not list it.
  assert.equal(backgroundSessionModelOptions([], { model: 'openai-codex/gpt-6-sol' })[0].value, 'openai-codex/gpt-6-sol');
  assert.deepEqual(backgroundSessionModelOptions(options, null), []);
});
