import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalUserStatusChip } from '../src/features/canonical/readModel/messageMapping';
import { messageDeliveryVisual } from '../src/features/chat/deliveryStatus';
import {
  shouldKeepCollaborationSendPending,
  shouldShowCollaborationSendFailureNotice,
} from '../src/features/chat/messageActions/collaborationSendLifecycle';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';

test('messageDeliveryVisual maps sent and delivered to a single gray check', () => {
  assert.deepEqual(messageDeliveryVisual('sent'), {
    glyph: 'single-check',
    tone: 'gray',
    label: 'Sent',
  });
  assert.deepEqual(messageDeliveryVisual('delivered'), {
    glyph: 'single-check',
    tone: 'gray',
    label: 'Delivered',
  });
});

test('messageDeliveryVisual maps read and responded to quiet double checks', () => {
  assert.deepEqual(messageDeliveryVisual('read'), {
    glyph: 'double-check',
    tone: 'gray',
    label: 'Read',
  });
  assert.deepEqual(messageDeliveryVisual('responded'), {
    glyph: 'double-check',
    tone: 'gray',
    label: 'Read',
  });
});

test('inline bridge send failures do not also show a sidebar failure notice', () => {
  assert.equal(shouldShowCollaborationSendFailureNotice(true), false);
  assert.equal(shouldShowCollaborationSendFailureNotice(false), true);
});

test('retryable Cloud sends remain pending until durable sync confirms delivery', () => {
  assert.equal(shouldKeepCollaborationSendPending(
    new CloudAuthError('network_error', 'timed out', 0),
  ), true);
  assert.equal(shouldKeepCollaborationSendPending(
    new CloudAuthError('rate_limited', 'try later', 429),
  ), true);
  assert.equal(shouldKeepCollaborationSendPending(
    new CloudAuthError('server_error', 'unavailable', 503),
  ), true);
  assert.equal(shouldKeepCollaborationSendPending(
    new Error('Empty response from chat sync server.'),
  ), true);
});

test('definitive Cloud send rejection becomes an inline failure', () => {
  assert.equal(shouldKeepCollaborationSendPending(
    new CloudAuthError('invalid_attachment', 'invalid attachment', 400),
  ), false);
});

test('messageDeliveryVisual marks sending clock as animated', () => {
  assert.deepEqual(messageDeliveryVisual('sending'), {
    glyph: 'clock',
    tone: 'gray',
    label: 'Sending',
    motion: 'pulse',
  });
});

test('agent-session status semantics use sent for queued work and responded for finished work', () => {
  assert.deepEqual(messageDeliveryVisual('sent'), {
    glyph: 'single-check',
    tone: 'gray',
    label: 'Sent',
  });
  assert.deepEqual(messageDeliveryVisual('responded'), {
    glyph: 'double-check',
    tone: 'gray',
    label: 'Read',
  });
});

test('canonical in-progress agent handoff user chips stay single-check sent', () => {
  const message = { status: 'sent' } as Parameters<typeof canonicalUserStatusChip>[0];

  assert.equal(canonicalUserStatusChip(message, { deliveryState: 'processing' }), 'sent');
  assert.equal(canonicalUserStatusChip(message, { deliveryState: 'handed_off_direct' }), 'sent');
  assert.equal(canonicalUserStatusChip(message, { deliveryState: 'handed_off_mailbox' }), 'sent');
  assert.equal(canonicalUserStatusChip(message, { deliveryState: 'responded' }), 'responded');
});

test('messageDeliveryVisual keeps transient and failure states distinct', () => {
  assert.equal(messageDeliveryVisual('pending_send')?.motion, 'pulse');
  assert.equal(messageDeliveryVisual('processing')?.glyph, 'spinner');
  assert.deepEqual(messageDeliveryVisual('processing_failed'), {
    glyph: 'exclamation',
    tone: 'red',
    label: 'Sending failed',
  });
  assert.deepEqual(messageDeliveryVisual('failed'), {
    glyph: 'exclamation',
    tone: 'red',
    label: 'Sending failed',
  });
  assert.deepEqual(messageDeliveryVisual('partial'), {
    glyph: 'exclamation',
    tone: 'red',
    label: 'Partially delivered',
  });
});
