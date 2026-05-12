import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composerConfigTargetSessionId } from '../src/features/chat/useComposerInputActions';

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
