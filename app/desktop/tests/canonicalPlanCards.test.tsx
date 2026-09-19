import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import type { CanonicalSessionState, Message } from '../src/kordi-app/types';

function readModel() {
  const state: CanonicalSessionState = {
    storagePath: '',
    profile: { id: 'profile', humanIdentityId: 'me', storageRoot: '', createdAtMs: 1, updatedAtMs: 1 },
    identities: [{ id: 'pip', kind: 'human', displayName: 'PiP', source: 'cloud', avatarKey: 'pip', createdAtMs: 1, updatedAtMs: 1 }],
    sessions: [{ id: 'group', kind: 'group', title: 'Test group', status: 'active', createdByIdentityId: 'me', createdAtMs: 1, updatedAtMs: 2 }],
    participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    messages: [{ id: 'card-message', sessionId: 'group', senderIdentityId: 'pip', senderRole: 'person', messageKind: 'text',
      contentText: '', status: 'received', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 2,
      content: { planCard: { eventId: 'plan', title: 'Lunch', revision: 10, state: 'awaiting_confirmation', view: 'event', participants: [], unresolvedFields: [], options: [] } },
    }],
  };
  return createCanonicalSessionReadModel(state)!;
}

test('equal-length cached transcripts recover a card-only message from canonical history', () => {
  const model = readModel();
  const canonical = model.messages('group');
  const cached = canonical.map((message) => ({ ...message, planCard: null }));
  const visible = model.preferMessages('group', cached);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].planCard?.revision, 10);
  assert.equal(visible[0].text, '');
  assert.equal(visible[0].id, canonical[0].id);
  const unrelated: Message[] = [{ id: 'different-message', role: 'person', text: 'Other message', time: '' }];
  assert.equal(model.preferMessages('group', unrelated), unrelated);
});

test('canonical card refreshes preserve cached transcript content and never downgrade newer cards', () => {
  const model = readModel();
  const [canonical] = model.messages('group');
  const cached: Message = { ...canonical, detail: 'Local detail', planCard: { ...canonical.planCard!, revision: 9 } };
  const extra: Message = { id: 'pending', role: 'user', text: 'Pending local message', time: '' };
  const updated = model.preferMessages('group', [cached, extra]);
  assert.equal(updated[0].planCard?.revision, 10);
  assert.equal(updated[0].detail, 'Local detail');
  assert.equal(updated[1], extra);
  const newer = [{ ...cached, planCard: { ...cached.planCard!, revision: 11 } }, extra];
  assert.equal(model.preferMessages('group', newer), newer);
  assert.equal(model.preferMessages('group', updated), updated);
});
