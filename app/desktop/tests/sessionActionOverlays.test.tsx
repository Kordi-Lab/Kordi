import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DeleteSessionDialog,
  MoveSessionDialog,
  ProjectCreateDialog,
  RenameSessionDialog,
  SessionContextMenu,
} from '../src/pages/SessionActionOverlays';

function dialogPanelClass(markup: string) {
  const match = markup.match(/<div class="([^"]*)"[^>]*role="dialog"/);
  assert.ok(match, 'expected a semantic dialog panel');
  return match[1];
}

function dialogLayerClass(markup: string, presentation: 'modal' | 'popover') {
  const match = markup.match(new RegExp(`<div class="([^"]*)" data-dialog-presentation="${presentation}"`));
  assert.ok(match, `expected a ${presentation} dialog layer`);
  return match[1];
}

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

test('SessionContextMenu keeps ordinary actions flat at rest', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1024, innerHeight: 768 },
  });

  const markup = renderToStaticMarkup(createElement(SessionContextMenu, {
    target: {
      sessionId: 'session:one',
      sessionName: 'Trip planning',
      x: 120,
      y: 120,
      canMoveToProject: true,
    },
    onClose: () => {},
    onRename: () => {},
    onMove: () => {},
    onDelete: () => {},
  }));

  assert.match(markup, /app-transient-flat-action[^>]*>Rename…</);
  assert.match(markup, /app-transient-flat-action[^>]*>Move to project…</);
  assert.match(markup, /app-transient-row app-transient-row-danger[^>]*>Remove chat…</);
  assert.doesNotMatch(markup, /app-transient-row[^>]*>Rename…</);
});

test('SessionContextMenu hides rename for a non-admin group member', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1024, innerHeight: 768 },
  });

  const markup = renderToStaticMarkup(createElement(SessionContextMenu, {
    target: {
      sessionId: 'session:group:one',
      sessionName: 'main',
      x: 120,
      y: 120,
      canRename: false,
    },
    onClose: () => {},
    onRename: () => {},
    onMove: () => {},
    onDelete: () => {},
  }));

  assert.doesNotMatch(markup, /Rename…/);
  assert.match(markup, /Remove chat…/);
});

test('RenameSessionDialog uses the anchored popout presentation', () => {
  const html = renderToStaticMarkup(createElement(RenameSessionDialog, {
      target: {
        sessionId: 'session-1',
        sessionName: 'Planning',
        anchorRect: { left: 120, top: 80, width: 1, height: 1 },
      },
      onCancel: () => {},
      onConfirm: () => {},
    }));

  assert.match(html, /data-dialog-presentation="popover"/);
  assert.match(html, />Rename session</);
  assert.match(html, />Cancel</);
  assert.match(html, />Rename</);
});

test('DeleteSessionDialog keeps the confirmation concise and exposes semantic actions', () => {
  const removeMarkup = renderToStaticMarkup(createElement(DeleteSessionDialog, {
    target: {
      sessionId: 'session:one',
      sessionName: 'Trip planning',
      anchorRect: { left: 120, top: 120, width: 1, height: 1 },
    },
    onCancel: () => {},
    onConfirm: async () => {},
  }));
  const renameMarkup = renderToStaticMarkup(createElement(RenameSessionDialog, {
    target: { sessionId: 'session:one', sessionName: 'Trip planning' },
    onCancel: () => {},
    onConfirm: () => {},
  }));

  assert.match(removeMarkup, /Remove chat\?/);
  assert.match(removeMarkup, /role="dialog"/);
  assert.match(removeMarkup, /aria-modal="true"/);
  assert.match(removeMarkup, /data-dialog-presentation="popover"/);
  assert.match(dialogLayerClass(removeMarkup, 'popover'), /bg-transparent/);
  assert.doesNotMatch(dialogLayerClass(removeMarkup, 'popover'), /app-overlay|backdrop-blur/);
  assert.match(dialogPanelClass(removeMarkup), /app-frosted-popover/);
  assert.doesNotMatch(dialogPanelClass(removeMarkup), /app-modal-panel/);
  assert.match(dialogPanelClass(renameMarkup), /app-frosted-popover/);
  assert.match(removeMarkup, /app-control-chip[^\"]*h-9[^\"]*rounded-\[12px\][^\"]*px-3/);
  assert.match(removeMarkup, /app-button-primary[^\"]*h-9[^\"]*rounded-\[12px\][^\"]*px-3/);
  assert.doesNotMatch(removeMarkup, /app-button-muted|app-button-destructive/);
  assert.match(removeMarkup, />Cancel</);
  assert.match(removeMarkup, />Remove chat</);
  assert.doesNotMatch(removeMarkup, /removed from your chat list/);
  assert.doesNotMatch(removeMarkup, /It will show again when there is a new update/);
  assert.doesNotMatch(removeMarkup, /permanently removed/);
  assert.doesNotMatch(removeMarkup, /cannot be recovered/);
  assert.doesNotMatch(removeMarkup, /Trip planning/);
});

test('larger session action forms share the semantic modal frame and standard action row', () => {
  const moveMarkup = renderToStaticMarkup(createElement(MoveSessionDialog, {
    target: { sessionId: 'session:one', sessionName: 'Trip planning' },
    projects: [],
    onCancel: () => {},
    onMoveToProject: () => {},
  }));
  const createMarkup = renderToStaticMarkup(createElement(ProjectCreateDialog, {
    onCancel: () => {},
    onCreateFromFolder: () => {},
    onCreateNew: () => {},
  }));

  for (const markup of [moveMarkup, createMarkup]) {
    assert.match(markup, /data-dialog-presentation="modal"/);
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-modal="true"/);
    assert.match(dialogPanelClass(markup), /app-modal-panel/);
    assert.match(markup, /app-control-chip/);
    assert.match(markup, /app-button-primary/);
  }
});
