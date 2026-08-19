import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TranscriptImageDeliveryOverlay } from '../src/kordi-app/components/transcriptImageDeliveryOverlay';

test('active image uploads expose determinate progress and cancellation', () => {
  const markup = renderToStaticMarkup(createElement(TranscriptImageDeliveryOverlay, {
    visual: { kind: 'uploading', label: 'Sending image' },
    foregroundTone: 'light',
    uploadProgress: 42.8,
    onCancelUpload: () => {},
  }));

  assert.match(markup, /aria-label="Sending image, 42%"/);
  assert.match(markup, /data-determinate="true"/);
  assert.match(markup, /app-attachment-image-media-ring-label">42%/);
  assert.match(markup, /aria-label="Cancel image upload"/);
});
