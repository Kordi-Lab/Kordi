import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  cloudGroupAgentFailureNoticeRequest,
} from '../src/features/cloud/cloudGroupAgentFailure';

test('generic invocation failure terminates the stable processing slot', () => {
  const request = cloudGroupAgentFailureNoticeRequest({
    accountId: 'acct_me',
    groupId: 'group:one',
    requestId: 'request:one',
    agentDisplayName: 'My Kordi',
    error: new Error('Runtime admission failed'),
    now: 5_000,
  });

  assert.equal(
    request.id,
    'msg:cloud-agent-processing:request:one:acct_me',
  );
  assert.equal(request.status, 'failed');
  assert.equal(request.content.deliveryState, 'failed');
  assert.equal(request.content.error, 'Runtime admission failed');
});

test('no-provider failure uses the actionable provider notice', () => {
  const request = cloudGroupAgentFailureNoticeRequest({
    accountId: 'acct_me',
    groupId: 'group:one',
    requestId: 'request:one',
    agentDisplayName: 'My Kordi',
    error: new Error('No provider configured yet.'),
  });

  assert.equal(request.status, 'failed');
  assert.match(String(request.content.error), /provider/i);
  assert.match(request.sourceEventId ?? '', /no-provider/);
});

test('failure fanout runs after local terminal persistence without blocking FIFO', () => {
  const source = readFileSync(
    new URL(
      '../src/features/cloud/cloudGroupAgentFailure.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const terminalUpsert = source.indexOf(
    'persistedResponse = await upsertCanonicalMessageFast(',
  );
  const backgroundFanout = source.indexOf(
    'void publishCloudGroupAgentFailure({',
    terminalUpsert,
  );

  assert.ok(terminalUpsert >= 0, 'expected local terminal persistence');
  assert.ok(
    backgroundFanout > terminalUpsert,
    'failure fanout must start only after local terminal persistence',
  );
});
