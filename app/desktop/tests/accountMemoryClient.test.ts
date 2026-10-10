import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudAuthClient, type CloudAccount } from '../src/features/cloud/authClient';
import { CloudMemoryClient, type CloudMemory, type CloudMemorySettings } from '../src/features/cloud/cloudMemoryClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import type { StoredSession } from '../src/features/cloud/session';
import {
  SIGN_IN_TO_EDIT_MEMORIES,
  createAccountMemoryClient,
  type AccountMemoryAuthClient,
  type AccountMemoryRoutes,
  type AccountMemoryDesktop,
} from '../src/features/memory/accountMemoryClient';
import type { DesktopLocalMemory, DesktopMemorySettings } from '../src/lib/desktopMemory';

const session: StoredSession = { token: 'token-1', accountId: 'acct-1', expiresAt: '2027-01-01T00:00:00Z' };
const NOW = Date.parse('2026-10-07T12:00:00.000Z');

function memory(overrides: Partial<CloudMemory>): CloudMemory {
  return {
    memoryId: 'mem-1',
    scope: 'conversation',
    scopeId: 'conv-1',
    scopeLabel: 'Launch copy',
    source: 'manual',
    text: 'Keep headlines short.',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

type Call = [string, ...unknown[]];

type FakeAuth = AccountMemoryRoutes & Pick<AccountMemoryAuthClient, 'me'>;

function wire(fake: FakeAuth) {
  return { authClient: fake as unknown as AccountMemoryAuthClient, memoryRoutes: fake };
}

function fakeAuth(overrides: Partial<FakeAuth> = {}) {
  const calls: Call[] = [];
  let settings: CloudMemorySettings = { memoryEnabled: false, excludeSensitive: true };
  const client: FakeAuth = {
    async list(token) {
      calls.push(['listMemories', token]);
      return {
        memories: [
          memory({ memoryId: 'mem-1', scope: 'conversation', scopeLabel: null }),
          memory({ memoryId: 'mem-2', scope: 'project', scopeLabel: '~/Projects/site' }),
          memory({ memoryId: 'mem-3', scope: 'group', scopeLabel: null }),
          memory({ memoryId: 'mem-4', scope: 'project', scopeLabel: '  ' }),
        ],
        settings,
      };
    },
    async update(token, memoryId, text) {
      calls.push(['updateMemory', token, memoryId, text]);
      return memory({ memoryId, text, scopeLabel: null });
    },
    async remove(token, memoryId) {
      calls.push(['deleteMemory', token, memoryId]);
    },
    async forgetAll(token) {
      calls.push(['forgetAllMemories', token]);
      return { archived: 3 };
    },
    async settings(token) {
      calls.push(['memorySettings', token]);
      return settings;
    },
    async updateSettings(token, patch) {
      calls.push(['updateMemorySettings', token, patch]);
      settings = { ...settings, ...patch };
      return settings;
    },
    async me(token) {
      calls.push(['me', token]);
      return { accountId: 'acct-1', primaryEmail: 'taylor@memory.example', displayName: 'Taylor', kordiId: '517309264' } as CloudAccount;
    },
    ...overrides,
  };
  return { client, calls };
}

function fakeDesktop(native = true, local: DesktopLocalMemory[] = []) {
  const calls: Call[] = [];
  let settings: DesktopMemorySettings = { memoryEnabled: true, excludeSensitive: false };
  const desktop: AccountMemoryDesktop = {
    isNativeShell: () => native,
    async settings() {
      calls.push(['settings']);
      return settings;
    },
    async updateSettings(patch) {
      calls.push(['updateSettings', patch]);
      settings = { ...settings, ...patch };
      return settings;
    },
    async sync() {
      calls.push(['sync']);
      return { uploaded: 0, downloaded: 0, rejected: 0, settings: null };
    },
    async listLocal() {
      calls.push(['listLocal']);
      return local;
    },
  };
  return { desktop, calls };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('list maps memory ids and fills missing scope labels', async () => {
  const auth = fakeAuth();
  const native = fakeDesktop();
  const client = createAccountMemoryClient({ ...wire(auth.client), loadSession: async () => session, desktop: native.desktop, now: () => NOW });
  const lessons = await client.listLessons();
  assert.deepEqual(lessons.map((lesson) => [lesson.lessonId, lesson.scopeLabel]), [
    ['mem-1', 'Conversation'],
    ['mem-2', '~/Projects/site'],
    ['mem-3', 'Group'],
    ['mem-4', 'Project'],
  ]);
  assert.equal('memoryId' in lessons[0], false);
  await settle();
  assert.deepEqual(native.calls, [['sync']]);
  assert.deepEqual(await client.syncState(), { accountLabel: 'taylor@memory.example', lastSyncedAt: new Date(NOW).toISOString() });
});

test('settings map memoryEnabled to lessonsEnabled and mirror to this Mac', async () => {
  const auth = fakeAuth();
  const native = fakeDesktop();
  const client = createAccountMemoryClient({ ...wire(auth.client), loadSession: async () => session, desktop: native.desktop });
  assert.deepEqual(await client.settings(), { lessonsEnabled: false, excludeSensitive: true });
  await settle();
  assert.deepEqual(native.calls, [['updateSettings', { memoryEnabled: false, excludeSensitive: true }]]);

  native.calls.length = 0;
  assert.deepEqual(await client.updateSettings({ lessonsEnabled: true }), { lessonsEnabled: true, excludeSensitive: true });
  assert.deepEqual(auth.calls.at(-1), ['updateMemorySettings', 'token-1', { memoryEnabled: true }]);
  await settle();
  assert.deepEqual(native.calls, [['updateSettings', { memoryEnabled: true, excludeSensitive: true }]]);
});

test('settings outside the native shell skip the desktop commands', async () => {
  const native = fakeDesktop(false);
  const client = createAccountMemoryClient({ ...wire(fakeAuth().client), loadSession: async () => session, desktop: native.desktop });
  await client.settings();
  await client.listLessons();
  await settle();
  assert.deepEqual(native.calls, []);
});

test('a missing desktop command does not fail account writes', async () => {
  const native = fakeDesktop();
  native.desktop.sync = async () => { throw new Error('Command desktop_memory_sync not found'); };
  const client = createAccountMemoryClient({ ...wire(fakeAuth().client), loadSession: async () => session, desktop: native.desktop });
  await client.archiveLesson('mem-1');
  await settle();
});

test('update, delete, and forget call the account routes and record the sync time', async () => {
  const auth = fakeAuth();
  const native = fakeDesktop();
  let time = NOW;
  const client = createAccountMemoryClient({ ...wire(auth.client), loadSession: async () => session, desktop: native.desktop, now: () => time });
  assert.equal((await client.syncState()).lastSyncedAt, null);

  const updated = await client.updateLesson('mem-9', 'Use sentence case.');
  assert.deepEqual([updated.lessonId, updated.text, updated.scopeLabel], ['mem-9', 'Use sentence case.', 'Conversation']);
  assert.equal((await client.syncState()).lastSyncedAt, new Date(NOW).toISOString());

  time += 60_000;
  await client.archiveLesson('mem-9');
  assert.equal((await client.syncState()).lastSyncedAt, new Date(time).toISOString());

  time += 60_000;
  assert.deepEqual(await client.forgetAll(), { archived: 3 });
  assert.equal((await client.syncState()).lastSyncedAt, new Date(time).toISOString());

  assert.deepEqual(auth.calls.filter(([name]) => name !== 'me'), [
    ['updateMemory', 'token-1', 'mem-9', 'Use sentence case.'],
    ['deleteMemory', 'token-1', 'mem-9'],
    ['forgetAllMemories', 'token-1'],
  ]);
  assert.equal(auth.calls.filter(([name]) => name === 'me').length, 1);
  await settle();
  assert.deepEqual(native.calls, [['sync'], ['sync'], ['sync']]);
});

test('a server rejection reaches the panel as the error message', async () => {
  const auth = fakeAuth({
    async update() {
      throw new CloudAuthError('memory_rejected', 'Memories cannot contain secrets.', 422);
    },
  });
  const client = createAccountMemoryClient({ ...wire(auth.client), loadSession: async () => session, desktop: fakeDesktop().desktop });
  await assert.rejects(client.updateLesson('mem-1', 'token=abc'), { message: 'Memories cannot contain secrets.' });
  assert.equal((await client.syncState()).lastSyncedAt, null);
});

test('signed out, the list and settings come from this Mac', async () => {
  const auth = fakeAuth();
  const native = fakeDesktop(true, [{
    lessonId: 'local-1',
    scope: 'group',
    scopeId: 'group-1',
    scopeLabel: null,
    source: 'outcome',
    text: 'Share screenshots as attachments.',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    pendingUpload: true,
  }]);
  const client = createAccountMemoryClient({ ...wire(auth.client), loadSession: async () => null, desktop: native.desktop });
  const lessons = await client.listLessons();
  assert.deepEqual(lessons, [{
    lessonId: 'local-1',
    scope: 'group',
    scopeId: 'group-1',
    scopeLabel: 'Group',
    source: 'outcome',
    text: 'Share screenshots as attachments.',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  }]);
  assert.deepEqual(await client.settings(), { lessonsEnabled: true, excludeSensitive: false });
  assert.deepEqual(await client.updateSettings({ excludeSensitive: true }), { lessonsEnabled: true, excludeSensitive: true });
  assert.deepEqual(await client.syncState(), { accountLabel: '', lastSyncedAt: null });
  assert.deepEqual(auth.calls, []);
  assert.deepEqual(native.calls.map(([name]) => name), ['listLocal', 'settings', 'updateSettings']);
});

test('signed out outside the native shell, settings fall back to defaults', async () => {
  const client = createAccountMemoryClient({ ...wire(fakeAuth().client), loadSession: async () => null, desktop: fakeDesktop(false).desktop });
  assert.deepEqual(await client.settings(), { lessonsEnabled: true, excludeSensitive: true });
  assert.deepEqual(await client.listLessons(), []);
});

test('signed out, edits ask the person to sign in', async () => {
  const auth = fakeAuth();
  const client = createAccountMemoryClient({ ...wire(auth.client), loadSession: async () => null, desktop: fakeDesktop().desktop });
  await assert.rejects(client.updateLesson('mem-1', 'New text.'), { message: SIGN_IN_TO_EDIT_MEMORIES });
  await assert.rejects(client.archiveLesson('mem-1'), { message: SIGN_IN_TO_EDIT_MEMORIES });
  await assert.rejects(client.forgetAll(), { message: SIGN_IN_TO_EDIT_MEMORIES });
  assert.equal(SIGN_IN_TO_EDIT_MEMORIES, 'Sign in to edit memories.');
  assert.deepEqual(auth.calls, []);
});

test('the sync row falls back to the display name and Kordi handle', async () => {
  const label = async (account: Partial<CloudAccount>) => {
    const client = createAccountMemoryClient({
      ...wire(fakeAuth({ async me() { return account as CloudAccount; } }).client),
      loadSession: async () => session,
      desktop: fakeDesktop(false).desktop,
    });
    return (await client.syncState()).accountLabel;
  };
  assert.equal(await label({ primaryEmail: null, displayName: 'Taylor', kordiId: '517309264' }), 'Taylor');
  assert.equal(await label({ primaryEmail: null, displayName: '', kordiId: '517309264' }), '@517309264');
});

test('the auth client calls the memory routes with the session token', async () => {
  const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, auth: headers.get('authorization'), body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/cloud/memory/mem%2F1' && init?.method === 'PATCH') {
      return json(422, { errorCode: 'memory_rejected', message: 'Memories cannot contain secrets.' });
    }
    if (init?.method === 'DELETE' && url.pathname.startsWith('/v1/cloud/memory/')) return new Response(null, { status: 204 });
    if (url.pathname === '/v1/cloud/memory' && init?.method === 'DELETE') return json(200, { archived: 2 });
    if (url.pathname === '/v1/cloud/memory') return json(200, { memories: [], settings: { memoryEnabled: true, excludeSensitive: true } });
    if (url.pathname === '/v1/cloud/memory/settings') return json(200, { memoryEnabled: false, excludeSensitive: true });
    return json(404, { errorCode: 'memory_not_found', message: 'Not found.' });
  };
  const auth = new CloudAuthClient({ baseUrl: 'https://api.memory.example', fetchImpl });
  const client = new CloudMemoryClient((path, init, fallback) => auth.request(path, init, fallback));
  assert.deepEqual((await client.list('tok')).memories, []);
  await assert.rejects(client.update('tok', 'mem/1', 'token=abc'), { message: 'Memories cannot contain secrets.', status: 422, code: 'memory_rejected' });
  await client.remove('tok', 'mem-2');
  assert.deepEqual(await client.forgetAll('tok'), { archived: 2 });
  assert.deepEqual(await client.settings('tok'), { memoryEnabled: false, excludeSensitive: true });
  await client.updateSettings('tok', { memoryEnabled: false });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'GET /v1/cloud/memory',
    'PATCH /v1/cloud/memory/mem%2F1',
    'DELETE /v1/cloud/memory/mem-2',
    'DELETE /v1/cloud/memory',
    'GET /v1/cloud/memory/settings',
    'PUT /v1/cloud/memory/settings',
  ]);
  assert.ok(calls.every((call) => call.auth === 'Bearer tok'));
  assert.deepEqual(calls[1].body, { text: 'token=abc' });
  assert.deepEqual(calls[5].body, { memoryEnabled: false });
});
