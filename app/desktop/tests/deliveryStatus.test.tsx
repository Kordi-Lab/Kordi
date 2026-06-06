import assert from 'node:assert/strict';
import test from 'node:test';

import { messageDeliveryVisual } from '../src/features/chat/deliveryStatus';
import { shouldShowBridgeSendFailureNotice } from '../src/features/chat/messageActions/chatMessages';

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
  assert.equal(shouldShowBridgeSendFailureNotice(true), false);
  assert.equal(shouldShowBridgeSendFailureNotice(false), true);
});

test('messageDeliveryVisual marks sending clock as animated', () => {
  assert.deepEqual(messageDeliveryVisual('sending'), {
    glyph: 'clock',
    tone: 'gray',
    label: 'Sending',
    motion: 'pulse',
  });
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
});
