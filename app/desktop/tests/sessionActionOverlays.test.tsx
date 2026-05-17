import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeleteSessionDialog, SessionContextMenu } from '../src/pages/SessionActionOverlays';

test('SessionContextMenu offers Remove chat without a separate Not show here action', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1024, innerHeight: 768 },
  });

  const markup = renderToStaticMarkup(createElement(SessionContextMenu, {
    target: { sessionId: 'session:one', sessionName: 'Trip planning', x: 120, y: 120 },
    onClose: () => {},
    onRename: () => {},
    onMove: () => {},
    onDelete: () => {},
  }));

  assert.doesNotMatch(markup, /Not show here/);
  assert.doesNotMatch(markup, /Delete forever/);
  assert.match(markup, /Remove chat…/);
});

test('DeleteSessionDialog presents remove chat as a recoverable list removal', () => {
  const markup = renderToStaticMarkup(createElement(DeleteSessionDialog, {
    target: { sessionId: 'session:one', sessionName: 'Trip planning' },
    onCancel: () => {},
    onConfirm: async () => {},
  }));

  assert.match(markup, /Remove chat\?/);
  assert.match(markup, /removed from your chat list/);
  assert.match(markup, /It will show again when there is a new update/);
  assert.doesNotMatch(markup, /permanently removed/);
  assert.doesNotMatch(markup, /cannot be recovered/);
  assert.match(markup, /Trip planning/);
});
