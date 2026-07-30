import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const chatStartSource = () => readFileSync(new URL('../src/app/useKordiChatStartActions.ts', import.meta.url), 'utf8');
const canonicalMutationSource = () => readFileSync(new URL('../src/app/canonicalSessionStateMutations.ts', import.meta.url), 'utf8');

test('chat create flows use compact canonical writes instead of full-state reloads', () => {
  const source = chatStartSource();
  const personStart = source.indexOf('const startChatWithPerson');
  const agentStart = source.indexOf('const startChatWithAgent');
  const agentHelperStart = source.indexOf('async function startCanonicalAgentSession');
  assert.notEqual(personStart, -1, 'expected person Enter Chat handler');
  assert.notEqual(agentStart, -1, 'expected agent Enter Chat handler');
  assert.notEqual(agentHelperStart, -1, 'expected canonical agent session helper');

  const personHandler = source.slice(personStart, agentStart);
  const agentHandler = source.slice(agentStart, agentHelperStart);
  const agentHelper = source.slice(agentHelperStart);

  for (const [name, handler] of [['person', personHandler], ['agent', agentHelper]] as const) {
    assert.match(handler, /upsertCanonicalIdentityFast/, `${name} Enter Chat should not parse a full canonical state after identity upsert`);
    assert.match(handler, /openOrCreateCanonicalSessionFast/, `${name} Enter Chat should not parse a full canonical state after session open`);
    assert.match(handler, /mergeOpenCanonicalSessionResult/, `${name} Enter Chat should merge compact session results into local state`);
  }
  assert.match(agentHandler, /startCanonicalAgentSession/);

  assert.doesNotMatch(source, /await upsertCanonicalIdentity\(/, 'chat create flows must not use full-state identity upsert');
  assert.doesNotMatch(source, /await openOrCreateCanonicalSession\(/, 'chat create flows must not use full-state session open');
});

test('compact session merge replaces the native participant list for that session', () => {
  const source = canonicalMutationSource();
  const mergeStart = source.indexOf('function mergeOpenCanonicalSessionResult');
  const mergeEnd = source.length;
  assert.notEqual(mergeStart, -1, 'expected compact session merge helper');
  assert.notEqual(mergeEnd, -1, 'expected compact session merge helper end');
  const mergeBlock = source.slice(mergeStart, mergeEnd);

  assert.match(
    mergeBlock,
    /participant\.sessionId !== result\.session\.id/,
    'compact session merge must replace all stale local participants for the native session',
  );
});
