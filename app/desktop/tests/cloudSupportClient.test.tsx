import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { createCloudSupportTicket } from '../src/features/cloud/supportClient';

test('support tickets use the authenticated durable intake endpoint', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: input.toString(), init });
    return Promise.resolve(new Response(JSON.stringify({
      ticketId: 'support_123',
      status: 'received',
      createdAt: '2026-08-04T00:00:00Z',
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const result = await createCloudSupportTicket(client, 'kordi_cs_xyz', {
    category: 'issue',
    subject: 'Group reply is delayed',
    description: 'The reply remains in Processing.',
    diagnostics: { platform: 'desktop' },
    clientSubmissionId: 'desktop:submission-1',
  });

  assert.equal(result.ticketId, 'support_123');
  assert.equal(calls[0].url, 'http://srv/v1/cloud/support/tickets');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer kordi_cs_xyz');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    category: 'issue',
    subject: 'Group reply is delayed',
    description: 'The reply remains in Processing.',
    diagnostics: { platform: 'desktop' },
    clientSubmissionId: 'desktop:submission-1',
  });
});
