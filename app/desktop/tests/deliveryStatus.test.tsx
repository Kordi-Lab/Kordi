import assert from 'node:assert/strict';
import test from 'node:test';

import { messageDeliveryVisual } from '../src/features/chat/deliveryStatus';

test('messageDeliveryVisual maps sent to a single gray check', () => {
  assert.deepEqual(messageDeliveryVisual('sent'), {
    glyph: 'single-check',
    tone: 'gray',
    label: 'Sent',
  });
});

test('messageDeliveryVisual maps delivered to gray double checks', () => {
  assert.deepEqual(messageDeliveryVisual('delivered'), {
    glyph: 'double-check',
    tone: 'gray',
    label: 'Delivered',
  });
});

test('messageDeliveryVisual maps read and responded to blue double checks', () => {
  assert.deepEqual(messageDeliveryVisual('read'), {
    glyph: 'double-check',
    tone: 'blue',
    label: 'Read',
  });
  assert.deepEqual(messageDeliveryVisual('responded'), {
    glyph: 'double-check',
    tone: 'blue',
    label: 'Read',
  });
});

test('messageDeliveryVisual keeps transient and failure states distinct', () => {
  assert.equal(messageDeliveryVisual('sending')?.glyph, 'clock');
  assert.equal(messageDeliveryVisual('processing')?.glyph, 'spinner');
  assert.equal(messageDeliveryVisual('processing_failed')?.glyph, 'exclamation');
  assert.equal(messageDeliveryVisual('failed')?.glyph, 'exclamation');
});
