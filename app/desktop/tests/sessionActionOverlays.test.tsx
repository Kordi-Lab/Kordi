import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DeleteSessionDialog,
  GroupContextMenu,
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
  const match = markup.match(new RegExp(`<div class="([^"]*)"[^>]*data-dialog-presentation="${presentation}"`));
  assert.ok(match, `expected a ${presentation} dialog layer`);
  return match[1];
}

const menuActions = {
  onClose: () => {},
  onRename: () => {},
  onArchive: () => {},
  onRestore: () => {},
  onSetPinned: () => {},
  onSetMuted: () => {},
  onSetUnread: () => {},
  onDelete: () => {},
};

test('SessionContextMenu exposes unread, pin, mute, archive, and reversible delete actions', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1024, innerHeight: 768 },
  });

  const markup = renderToStaticMarkup(createElement(SessionContextMenu, {
    target: { sessionId: 'session:one', sessionName: 'Trip planning', x: 120, y: 120 },
    ...menuActions,
  }));

  assert.doesNotMatch(markup, /Not show here/);
  assert.doesNotMatch(markup, /Delete forever/);
  assert.match(markup, />Pin</);
  assert.match(markup, />Mute notifications</);
  assert.match(markup, />Mark as unread</);
  assert.match(markup, />Archive</);
  assert.match(markup, /Delete chat…/);
  assert.equal((markup.match(/items-center gap-2\.5 whitespace-nowrap/g) ?? []).length, 5);
});

test('GroupContextMenu exposes whole-group chat actions', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1024, innerHeight: 768 },
  });
  const markup = renderToStaticMarkup(createElement(GroupContextMenu, {
    target: {
      groupSpaceId: 'session:group:mobile',
      groupName: 'Mobile builders',
      sessionIds: ['session:group:mobile', 'session:group:mobile-release'],
      x: 120,
      y: 120,
      pinned: true,
      muted: true,
    },
    onClose: () => {},
    onSetPinned: () => {},
    onSetMuted: () => {},
    onMarkRead: () => {},
    onArchive: () => {},
    onRestore: () => {},
  }));

  assert.match(markup, />Unpin group</);
  assert.match(markup, />Mark group as read</);
  assert.match(markup, />Unmute group</);
  assert.match(markup, />Archive group</);
});

test('GroupContextMenu restores an archived group', () => {
  const markup = renderToStaticMarkup(createElement(GroupContextMenu, {
    target: {
      groupSpaceId: 'session:group:mobile',
      groupName: 'Mobile builders',
      sessionIds: ['session:group:mobile', 'session:group:mobile-release'],
      x: 120,
      y: 120,
      archived: true,
    },
    onClose: () => {},
    onSetPinned: () => {},
    onSetMuted: () => {},
    onMarkRead: () => {},
    onArchive: () => {},
    onRestore: () => {},
  }));

  assert.match(markup, />Restore group</);
  assert.doesNotMatch(markup, /data-group-context-action="pin"/);
});

test('SessionContextMenu keeps available actions flat and omits the removed project action', () => {
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
    },
    ...menuActions,
  }));

  assert.match(markup, /app-transient-flat-action[^>]*>Rename…</);
  assert.match(markup, /app-transient-row app-transient-row-danger/);
  assert.match(markup, /Delete chat…/);
  assert.doesNotMatch(markup, /Move to project/);
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
    ...menuActions,
  }));

  assert.doesNotMatch(markup, /Rename…/);
  assert.match(markup, /Delete chat…/);
});

test('SessionContextMenu restores archived chats without offering pin', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1024, innerHeight: 768 },
  });
  const markup = renderToStaticMarkup(createElement(SessionContextMenu, {
    target: {
      sessionId: 'session:archived',
      sessionName: 'Archived',
      x: 120,
      y: 120,
      archived: true,
    },
    ...menuActions,
  }));

  assert.match(markup, />Restore</);
  assert.doesNotMatch(markup, /data-session-context-action="pin"/);
});

test('SessionContextMenu exposes the reverse preference actions', () => {
  const markup = renderToStaticMarkup(createElement(SessionContextMenu, {
    target: {
      sessionId: 'session:selected',
      sessionName: 'Selected',
      x: 120,
      y: 120,
      pinned: true,
      muted: true,
      unread: true,
    },
    ...menuActions,
  }));

  assert.match(markup, />Unpin</);
  assert.match(markup, />Unmute</);
  assert.match(markup, />Mark as read</);
  assert.match(markup, /lucide-pin-off/);
  assert.match(markup, /lucide-bell/);
  assert.doesNotMatch(markup, /lucide-bell-off/);
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

test('DeleteSessionDialog explains account-scoped soft deletion', () => {
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

  assert.match(removeMarkup, /Delete this chat from your list\?/);
  assert.match(removeMarkup, /role="dialog"/);
  assert.match(removeMarkup, /aria-modal="true"/);
  assert.match(removeMarkup, /data-dialog-presentation="popover"/);
  assert.match(dialogLayerClass(removeMarkup, 'popover'), /bg-transparent/);
  assert.doesNotMatch(dialogLayerClass(removeMarkup, 'popover'), /app-overlay|backdrop-blur/);
  assert.match(dialogPanelClass(removeMarkup), /app-frosted-popover/);
  assert.doesNotMatch(dialogPanelClass(removeMarkup), /app-modal-panel/);
  assert.match(dialogPanelClass(renameMarkup), /app-frosted-popover/);
  assert.match(removeMarkup, /app-button-quiet[^\"]*h-9[^\"]*rounded-\[12px\][^\"]*px-3/);
  assert.match(removeMarkup, /app-button-primary[^\"]*h-9[^\"]*rounded-\[12px\][^\"]*px-3/);
  assert.doesNotMatch(removeMarkup, /app-button-muted|app-button-destructive/);
  assert.match(removeMarkup, />Cancel</);
  assert.match(removeMarkup, />Delete chat</);
  assert.match(removeMarkup, /does not delete it for other participants/);
  assert.match(removeMarkup, /return if someone sends a new message/);
  assert.doesNotMatch(removeMarkup, /permanently removed/);
  assert.doesNotMatch(removeMarkup, /cannot be recovered/);
  assert.doesNotMatch(removeMarkup, /Trip planning/);
});

test('ProjectCreateDialog uses the semantic modal frame and standard action row', () => {
  const createMarkup = renderToStaticMarkup(createElement(ProjectCreateDialog, {
    onCancel: () => {},
    onCreateFromFolder: () => {},
    onCreateNew: () => {},
  }));

  assert.match(createMarkup, /data-dialog-presentation="modal"/);
  assert.match(createMarkup, /role="dialog"/);
  assert.match(createMarkup, /aria-modal="true"/);
  assert.match(dialogPanelClass(createMarkup), /app-modal-panel/);
  assert.match(createMarkup, /app-button-quiet/);
  assert.match(createMarkup, /app-button-primary/);
});
