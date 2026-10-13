import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ConversationParticipant, SessionArtifact } from '../src/kordi-app/types';
import { ArtifactListRow } from '../src/pages/ArtifactListRow';

const people: ConversationParticipant[] = [
  { id: 'acct_alex', name: 'Me', publicName: 'Alex Morgan', kind: 'human', role: 'owner' },
  { id: 'acct_priya', name: 'Priya Nair', kind: 'human', role: 'member' },
  { id: 'agent_lab', name: 'Lab agent', kind: 'agent', role: 'member' },
];

function row(artifact: Partial<SessionArtifact>, participants = people) {
  return renderToStaticMarkup(createElement(ArtifactListRow, {
    artifact: { id: 'a', path: 'notes.md', name: 'notes.md', kind: 'document', summary: 'Shared in Lab group', timeLabel: '14:54', ...artifact },
    location: '',
    isActive: false,
    participants,
    onSelect: () => undefined,
  }));
}

test('a row names the creator, shows the other people, and drops the redundant summary', () => {
  const markup = row({ createdByAccountId: 'acct_alex' });
  assert.match(markup, /data-artifact-creator="true"[^>]*title="Created by Alex Morgan"/);
  assert.match(markup, /data-artifact-participants="true"[^>]*title="Priya Nair"/, 'agents are not listed as people');
  assert.doesNotMatch(markup, /Shared in Lab group/);
  assert.match(markup, /14:54/);
});

test('a row without a known creator keeps its summary and shows no people', () => {
  const markup = row({ createdByAccountId: 'acct_unknown' });
  assert.doesNotMatch(markup, /data-artifact-creator|data-artifact-participants/);
  assert.match(markup, /Shared in Lab group · 14:54/);
});

test('the file badge follows the file type', () => {
  assert.match(row({ path: 'page.html', name: 'page.html' }), /title="HTML"/);
  assert.match(row({ path: 'notes.md' }), /title="Markdown"/);
  assert.match(row({ path: 'main.rs', name: 'main.rs', kind: 'code' }), /title="Code"/);
  assert.match(row({ path: 'data.bin', name: 'data.bin', kind: 'file' }), /title="File"/);
});
