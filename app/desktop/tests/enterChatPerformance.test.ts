import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const appModelSource = () => readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');

test('chat create flows use compact canonical writes instead of full-state reloads', () => {
  const source = appModelSource();
  const personStart = source.indexOf('const handleStartChatWithPerson');
  const agentStart = source.indexOf('const handleStartChatWithAgent');
  const groupStart = source.indexOf('const handleCreateChatGroup');
  assert.notEqual(personStart, -1, 'expected person Enter Chat handler');
  assert.notEqual(agentStart, -1, 'expected agent Enter Chat handler');
  assert.notEqual(groupStart, -1, 'expected next handler after agent Enter Chat');

  const personHandler = source.slice(personStart, agentStart);
  const agentHandler = source.slice(agentStart, groupStart);

  for (const [name, handler] of [['person', personHandler], ['agent', agentHandler]] as const) {
    assert.match(handler, /upsertCanonicalIdentityFast/, `${name} Enter Chat should not parse a full canonical state after identity upsert`);
    assert.match(handler, /openOrCreateCanonicalSessionFast/, `${name} Enter Chat should not parse a full canonical state after session open`);
    assert.match(handler, /mergeOpenCanonicalSessionResult/, `${name} Enter Chat should merge compact session results into local state`);
  }

  assert.doesNotMatch(source, /await upsertCanonicalIdentity\(/, 'chat create flows must not use full-state identity upsert');
  assert.doesNotMatch(source, /await openOrCreateCanonicalSession\(/, 'chat create flows must not use full-state session open');
});
