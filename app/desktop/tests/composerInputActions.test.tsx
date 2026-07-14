import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composerAttachmentItemFromStoredPath, composerConfigTargetSessionId } from '../src/features/chat/useComposerInputActions';
import * as composerInputActions from '../src/features/chat/useComposerInputActions';
import { localAgentComposerConfigTargetSessionId } from '../src/pages/ChatsPage';

test('isolated companion config updates preserve the active main desktop state', () => {
  const stateAfterUpdate = (
    composerInputActions as typeof composerInputActions & {
      desktopChatStateAfterConfigUpdate?: <T>(current: T, next: T, isolated: boolean) => T;
    }
  ).desktopChatStateAfterConfigUpdate;

  assert.equal(typeof stateAfterUpdate, 'function');
  if (!stateAfterUpdate) return;

  const mainState = { activeSessionId: 'session:main' };
  const companionState = { activeSessionId: 'session:companion' };
  assert.equal(stateAfterUpdate(mainState, companionState, true), mainState);
  assert.equal(stateAfterUpdate(mainState, companionState, false), companionState);
});

test('composer config routing does not target canonical Cloud direct or group sessions', () => {
  assert.equal(composerConfigTargetSessionId({
    scope: 'chat',
    activeConvId: 'session:direct-person:acct_me:acct_peer',
    activeConvCanonicalSessionId: 'session:direct-person:acct_me:acct_peer',
    activeProjectSessionId: 'project-session',
    desktopActiveSessionId: 'local-agent-session',
  }), null);

  assert.equal(composerConfigTargetSessionId({
    scope: 'chat',
    activeConvId: 'session:group:cloud-child',
    activeConvCanonicalSessionId: 'session:group:cloud-child',
    activeProjectSessionId: 'project-session',
    desktopActiveSessionId: 'local-agent-session',
  }), null);
});

test('composer path image attachments include a compressed preview for optimistic large-image rendering', async () => {
  const previewCalls: Array<{ storedPath: string; name: string; kind: string; mimeType?: string | null; sizeBytes?: number | null }> = [];

  const attachment = await composerAttachmentItemFromStoredPath({
    sourcePath: '/Users/alice/Pictures/huge.png',
    stored: {
      path: '/app-cache/huge.png',
      kind: 'image',
      mimeType: 'image/png',
      formatLabel: 'PNG',
      sizeBytes: 24 * 1024 * 1024,
    },
    createPreviewUrl: async (storedPath, metadata) => {
      previewCalls.push({ storedPath, name: metadata.name, kind: metadata.kind, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes });
      return 'data:image/webp;base64,preview';
    },
  });

  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.name.endsWith('.png'), true);
  assert.equal(attachment.path, '/app-cache/huge.png');
  assert.equal(attachment.previewUrl, 'data:image/webp;base64,preview');
  assert.deepEqual(previewCalls, [{
    storedPath: '/app-cache/huge.png',
    name: attachment.name,
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 24 * 1024 * 1024,
  }]);
});

test('composer config routing still targets local chat and project sessions', () => {
  assert.equal(composerConfigTargetSessionId({
    scope: 'chat',
    activeConvId: 'local-agent-session',
    activeConvCanonicalSessionId: 'local-agent-session',
    activeProjectSessionId: 'project-session',
    desktopActiveSessionId: 'local-agent-session',
  }), 'local-agent-session');

  assert.equal(composerConfigTargetSessionId({
    scope: 'project',
    activeConvId: 'session:group:cloud-child',
    activeConvCanonicalSessionId: 'session:group:cloud-child',
    activeProjectSessionId: 'project-session',
    desktopActiveSessionId: 'local-agent-session',
  }), 'project-session');
});

test('local agent composer config targets the canonical runtime session when available', () => {
  assert.equal(localAgentComposerConfigTargetSessionId({
    id: 'visible-self-agent-conversation',
    canonicalSessionId: 'session:self-agent:canonical-runtime',
  }), 'session:self-agent:canonical-runtime');
});

test('local agent composer config falls back to the visible conversation id', () => {
  assert.equal(localAgentComposerConfigTargetSessionId({
    id: 'visible-self-agent-conversation',
    canonicalSessionId: '   ',
  }), 'visible-self-agent-conversation');
});
