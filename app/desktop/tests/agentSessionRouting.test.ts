import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentSessionKind,
  agentSessionParticipantSpaceKind,
} from '../src/features/chat/agentSessionRouting';
import { agent } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('only default Kordi uses the generic self-agent session path', () => {
  const defaultKordi = agent({ id: 'desktop:local-agent', isOwned: true });
  const customAgent = agent({ id: 'agent:reviewer', isOwned: true });

  assert.equal(agentSessionKind(defaultKordi), 'self-agent');
  assert.equal(agentSessionParticipantSpaceKind(defaultKordi), 'self');
  assert.equal(agentSessionKind(customAgent), 'direct-agent');
  assert.equal(agentSessionParticipantSpaceKind(customAgent), 'direct-agent');
});
