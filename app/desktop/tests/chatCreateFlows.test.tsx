import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildChatCreateAgentOptions,
  buildChatCreateGroupMetadata,
  buildChatCreatePersonOptions,
  canCreateGroup,
  chatSessionIdForParticipantSpaceContinuation,
  existingBlankSessionIdForParticipantSpace,
  groupDefaultName,
  participantSpaceCanonicalSessionIds,
} from '../src/features/chat/chatCreateFlows';
import type { Agent, Contact, ParticipantSpaceViewModel } from '../src/kordi-app/types';

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact:alice',
    name: 'Alice',
    initials: 'A',
    classType: 'other-users',
    entityType: 'Person',
    subtitle: 'Human contact',
    bridges: ['Bridge'],
    status: 'Online',
    discoverableOn: ['Bridge'],
    detail: 'Works on product',
    owner: 'Alice',
    avatarSeed: 'alice',
    profileImageUrl: null,
    ...overrides,
  };
}

function participantSpace(overrides: Partial<ParticipantSpaceViewModel> = {}): ParticipantSpaceViewModel {
  return {
    id: 'direct-human:human:alice',
    kind: 'direct-human',
    title: 'Alice',
    participants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', bridgeNodeId: 'node-alice', avatarKey: 'alice' },
    ],
    participantCount: 2,
    sessionCount: 1,
    unread: 0,
    updatedAtLabel: '10:00',
    updatedAtMs: 1,
    preview: 'Hi',
    avatarStack: [{ kind: 'human', seed: 'alice', imageUrl: null }],
    sessions: [{
      id: 'session:bridge:humans:old',
      canonicalSessionId: 'session:bridge:humans:old',
      title: 'Hi',
      preview: 'Hi',
      unread: 0,
      updatedAtLabel: '10:00',
      updatedAtMs: 1,
      participantCount: 2,
      conversation: {
        id: 'session:bridge:humans:old',
        canonicalSessionId: 'session:bridge:humans:old',
        name: 'Hi',
        type: 'person',
        subtitle: 'Hi',
        unread: 0,
        bridges: ['Bridge'],
        trust: 'Bridge',
        directness: 'Direct chat',
        participants: ['Me', 'Alice'],
        canonicalParticipants: [
          { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
          { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', bridgeNodeId: 'node-alice', avatarKey: 'alice' },
        ],
        messages: [],
        updatedAtLabel: '10:00',
      },
    }],
    ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent:kordi',
    name: 'Kordi',
    role: 'Coding partner',
    messaging: 'Available',
    status: 'Ready',
    tasks: 0,
    defaultProvider: 'openai',
    defaultModel: 'gpt-5.2',
    bridgesConfig: 'Bridge',
    contactId: 'contact:kordi',
    systemPrompt: '',
    xMd: '',
    identityFiles: [],
    loadedTools: [],
    loadedSkills: [],
    loadedPlugins: [],
    lastActivities: [],
    avatarSeed: 'kordi',
    profileImageUrl: null,
    ...overrides,
  };
}

test('buildChatCreatePersonOptions excludes agent contacts', () => {
  const options = buildChatCreatePersonOptions([
    contact({ id: 'person:alice', name: 'Alice', entityType: 'Person' }),
    contact({ id: 'agent:one', name: 'Build bot', entityType: 'Owned agent', classType: 'my-agents' }),
    contact({ id: 'agent:two', name: 'Review bot', entityType: 'External agent', classType: 'other-users-agents' }),
  ]);

  assert.deepEqual(options.map((option) => option.id), ['person:alice']);
  assert.equal(options[0]?.label, 'Alice');
});

test('buildChatCreateAgentOptions derives agent rows from displayed agents', () => {
  const options = buildChatCreateAgentOptions([
    agent({ id: 'agent:kordi', name: 'Kordi', role: 'Coding partner' }),
    agent({ id: 'agent:reviewer', name: 'Reviewer', role: 'Code review' }),
  ]);

  assert.deepEqual(options.map((option) => option.label), ['Kordi', 'Reviewer']);
  assert.equal(options[0]?.detail, 'Coding partner');
});

test('canCreateGroup requires at least two unique people contacts', () => {
  assert.equal(canCreateGroup([]), false);
  assert.equal(canCreateGroup(['contact:alice']), false);
  assert.equal(canCreateGroup(['contact:alice', 'contact:alice']), false);
  assert.equal(canCreateGroup(['contact:alice', 'contact:bob']), true);
});

test('groupDefaultName uses people names only and truncates long groups', () => {
  assert.equal(groupDefaultName(['Alice', 'Bob']), 'Alice, Bob');
  assert.equal(groupDefaultName(['Alice', 'Bob', 'Chen', 'Dev']), 'Alice, Bob +2 more');
});

test('chatSessionIdForParticipantSpaceContinuation keeps Bridge human session ids consistent', () => {
  assert.equal(
    chatSessionIdForParticipantSpaceContinuation(participantSpace(), 'next-id'),
    'session:bridge:humans:next-id',
  );
  assert.equal(
    chatSessionIdForParticipantSpaceContinuation(participantSpace({
      sessions: [{
        ...participantSpace().sessions[0],
        id: 'session:direct-person:old',
        canonicalSessionId: 'session:direct-person:old',
      }],
      participants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:local-alice', name: 'Alice', kind: 'human', role: 'person', source: 'local', avatarKey: 'alice' },
      ],
    }), 'next-id'),
    'session:direct-person:next-id',
  );
});

test('existingBlankSessionIdForParticipantSpace reuses the newest blank session instead of creating another', () => {
  const space = participantSpace({
    sessions: [
      {
        ...participantSpace().sessions[0],
        id: 'session:bridge:humans:blank-newer',
        canonicalSessionId: 'session:bridge:humans:blank-newer',
        title: 'New session',
        preview: 'New session',
        updatedAtMs: 3,
        conversation: {
          ...participantSpace().sessions[0].conversation,
          id: 'session:bridge:humans:blank-newer',
          canonicalSessionId: 'session:bridge:humans:blank-newer',
          name: 'New session',
          subtitle: 'New session',
          messages: [],
        },
      },
      {
        ...participantSpace().sessions[0],
        id: 'session:bridge:humans:real-thread',
        canonicalSessionId: 'session:bridge:humans:real-thread',
        title: 'Release plan',
        preview: 'Ship it',
        updatedAtMs: 2,
        conversation: {
          ...participantSpace().sessions[0].conversation,
          id: 'session:bridge:humans:real-thread',
          canonicalSessionId: 'session:bridge:humans:real-thread',
          name: 'Release plan',
          subtitle: 'Ship it',
          messages: [{ role: 'person', sender: 'Alice', text: 'Ship it', time: '11:00' }],
        },
      },
      {
        ...participantSpace().sessions[0],
        id: 'session:bridge:humans:blank-older',
        canonicalSessionId: 'session:bridge:humans:blank-older',
        title: 'New session',
        preview: 'New session',
        updatedAtMs: 1,
        conversation: {
          ...participantSpace().sessions[0].conversation,
          id: 'session:bridge:humans:blank-older',
          canonicalSessionId: 'session:bridge:humans:blank-older',
          name: 'New session',
          subtitle: 'New session',
          messages: [],
        },
      },
    ],
  });

  assert.equal(existingBlankSessionIdForParticipantSpace(space), 'session:bridge:humans:blank-newer');
});

test('existingBlankSessionIdForParticipantSpace reuses legacy blank id families instead of creating another blank', () => {
  const space = participantSpace({
    sessions: [{
      ...participantSpace().sessions[0],
      id: 'session:direct-human:bad-blank',
      canonicalSessionId: 'session:direct-human:bad-blank',
      title: 'New session',
      preview: 'New session',
      conversation: {
        ...participantSpace().sessions[0].conversation,
        id: 'session:direct-human:bad-blank',
        canonicalSessionId: 'session:direct-human:bad-blank',
        name: 'New session',
        subtitle: 'New session',
        messages: [],
      },
    }],
  });

  assert.equal(existingBlankSessionIdForParticipantSpace(space), 'session:direct-human:bad-blank');
});

test('existingBlankSessionIdForParticipantSpace ignores New session rows that already have messages', () => {
  const space = participantSpace({
    sessions: [{
      ...participantSpace().sessions[0],
      id: 'session:bridge:humans:nonblank',
      canonicalSessionId: 'session:bridge:humans:nonblank',
      title: 'New session',
      preview: 'Hello',
      conversation: {
        ...participantSpace().sessions[0].conversation,
        id: 'session:bridge:humans:nonblank',
        canonicalSessionId: 'session:bridge:humans:nonblank',
        name: 'New session',
        subtitle: 'Hello',
        messages: [{ role: 'person', sender: 'Alice', text: 'Hello', time: '11:00' }],
      },
    }],
  });

  assert.equal(existingBlankSessionIdForParticipantSpace(space), null);
});

test('participantSpaceCanonicalSessionIds returns every canonical session in a group space', () => {
  const space = participantSpace({
    kind: 'group',
    id: 'group:session:group:root',
    sessions: [
      {
        ...participantSpace().sessions[0],
        id: 'session:group:followup',
        canonicalSessionId: 'session:group:followup',
      },
      {
        ...participantSpace().sessions[0],
        id: 'session:group:root-local-row',
        canonicalSessionId: 'session:group:root',
      },
      {
        ...participantSpace().sessions[0],
        id: 'session:group:root',
        canonicalSessionId: 'session:group:root',
      },
    ],
  });

  assert.deepEqual(participantSpaceCanonicalSessionIds(space), [
    'session:group:followup',
    'session:group:root',
  ]);
});

test('buildChatCreateGroupMetadata records stable admin and member policy', () => {
  const metadata = buildChatCreateGroupMetadata({
    creatorIdentityId: 'human:me',
    selectedContactIds: ['contact:alice', 'contact:bob'],
    selectedNames: ['Alice', 'Bob'],
    customName: 'Design crew',
    groupSpaceId: 'session:group:root',
  });

  assert.deepEqual(metadata.adminIdentityIds, ['human:me']);
  assert.deepEqual(metadata.initialContactIds, ['contact:alice', 'contact:bob']);
  assert.equal(metadata.customName, 'Design crew');
  assert.equal(metadata.groupSpaceId, 'session:group:root');
  assert.equal(metadata.memberApprovalPolicy, 'under-50-open');
});
