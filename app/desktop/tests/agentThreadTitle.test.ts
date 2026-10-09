import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sentenceCaseAgentThreadTitle } from '../src/features/chat/agentThreadTitle';

test('agent thread titles render in sentence case', () => {
  assert.equal(sentenceCaseAgentThreadTitle('Count Lines Across Project Files'), 'Count lines across project files');
  assert.equal(sentenceCaseAgentThreadTitle('Count lines across project files'), 'Count lines across project files');
  assert.equal(sentenceCaseAgentThreadTitle('Review API Docs For PR 1724'), 'Review API docs for PR 1724');
  assert.equal(sentenceCaseAgentThreadTitle('Check File_Map And V2 Output'), 'Check File_Map and V2 output');
  assert.equal(sentenceCaseAgentThreadTitle('Update GitHub Workflow Settings'), 'Update GitHub workflow settings');
  assert.equal(sentenceCaseAgentThreadTitle('Research the Sources'), 'Research the Sources');
  assert.equal(sentenceCaseAgentThreadTitle('Research'), 'Research');
});
