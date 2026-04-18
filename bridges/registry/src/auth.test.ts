import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { initSchema } from './db/schema.js';
import { createApp } from './server.js';
import type { Env } from './auth.js';

type JsonResponse = { status: number; json: unknown };

function createTestApp(): { db: Database.Database; app: Hono<Env> } {
  const db = new Database(':memory:');
  initSchema(db);
  return { db, app: createApp(db) };
}

async function requestJson(
  app: Hono<Env>,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {}
): Promise<JsonResponse> {
  const headers = new Headers();
  if (options.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const response = await app.request(`http://localhost${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const json = contentType.includes('application/json')
    ? await response.json()
    : { raw: await response.text() };

  return {
    status: response.status,
    json,
  };
}

async function registerNode(
  app: Hono<Env>,
  nodeId: string,
  ownerName: string,
  overrides: Record<string, unknown> = {}
): Promise<{ token: string; nodeId: string }> {
  const response = await requestJson(app, '/auth/register', {
    method: 'POST',
    body: {
      nodeId,
      displayName: nodeId,
      runtime: 'generic',
      endpoint: `http://${nodeId}.local`,
      ownerName,
      ...overrides,
    },
  });

  assert.equal(response.status, 201);
  const json = response.json as Record<string, unknown>;
  assert.equal(json.nodeId, nodeId);
  assert.equal(typeof json.token, 'string');
  return { token: json.token as string, nodeId };
}

async function createProject(app: Hono<Env>, token: string, slug = 'demo'): Promise<string> {
  const response = await requestJson(app, '/projects', {
    method: 'POST',
    token,
    body: { slug, displayName: slug.toUpperCase() },
  });

  assert.equal(response.status, 201);
  return (response.json as Record<string, unknown>).projectId as string;
}

async function createInvite(app: Hono<Env>, token: string, projectId: string, body: unknown = {}): Promise<string> {
  const response = await requestJson(app, `/projects/${projectId}/invites`, {
    method: 'POST',
    token,
    body,
  });

  assert.equal(response.status, 201);
  return (response.json as Record<string, unknown>).inviteToken as string;
}

test('refresh rotates the bearer token and invalidates the old one', async () => {
  const { app } = createTestApp();
  const { token } = await registerNode(app, 'node-a', 'Alice');

  const refresh = await requestJson(app, '/auth/refresh', {
    method: 'POST',
    token,
  });
  assert.equal(refresh.status, 200);
  const refreshJson = refresh.json as Record<string, unknown>;
  assert.equal(refreshJson.nodeId, 'node-a');
  assert.notEqual(refreshJson.token, token);

  const oldTokenResult = await requestJson(app, '/nodes', { token });
  assert.equal(oldTokenResult.status, 401);

  const newTokenResult = await requestJson(app, '/nodes', {
    token: refreshJson.token as string,
  });
  assert.equal(newTokenResult.status, 200);
  assert.equal(Array.isArray(newTokenResult.json), true);
});

test('registration rejects invalid node fields', async () => {
  const { app } = createTestApp();

  const invalidNodeId = await requestJson(app, '/auth/register', {
    method: 'POST',
    body: {
      nodeId: ' bad node ',
      displayName: 'Node A',
      runtime: 'generic',
      endpoint: 'http://node-a.local',
      ownerName: 'Alice',
    },
  });
  assert.equal(invalidNodeId.status, 400);

  const invalidEndpoint = await requestJson(app, '/auth/register', {
    method: 'POST',
    body: {
      nodeId: 'node-a',
      displayName: 'Node A',
      runtime: 'generic',
      endpoint: 'ftp://node-a.local',
      ownerName: 'Alice',
    },
  });
  assert.equal(invalidEndpoint.status, 400);

  const invalidPublicKey = await requestJson(app, '/auth/register', {
    method: 'POST',
    body: {
      nodeId: 'node-b',
      displayName: 'Node B',
      runtime: 'generic',
      endpoint: 'http://node-b.local',
      ownerName: 'Bob',
      publicKey: 'not-a-valid-key',
    },
  });
  assert.equal(invalidPublicKey.status, 400);
});

test('project creation ignores owner spoofing and validates slug format', async () => {
  const { app } = createTestApp();
  const owner = await registerNode(app, 'node-a', 'Alice');
  await registerNode(app, 'node-b', 'Bob');

  const invalidSlug = await requestJson(app, '/projects', {
    method: 'POST',
    token: owner.token,
    body: { slug: 'Bad Slug', displayName: 'Demo' },
  });
  assert.equal(invalidSlug.status, 400);

  const created = await requestJson(app, '/projects', {
    method: 'POST',
    token: owner.token,
    body: {
      slug: 'demo',
      displayName: 'Demo',
      ownerNodeId: 'node-b',
    },
  });

  assert.equal(created.status, 201);
  const projectId = (created.json as Record<string, unknown>).projectId as string;

  const project = await requestJson(app, `/projects/${projectId}`, {
    token: owner.token,
  });
  assert.equal(project.status, 200);
  assert.equal((project.json as Record<string, unknown>).ownerNodeId, 'node-a');
});

test('node discovery is limited to self and shared project members', async () => {
  const { app } = createTestApp();
  const alice = await registerNode(app, 'node-a', 'Alice');
  const bob = await registerNode(app, 'node-b', 'Bob');
  const charlie = await registerNode(app, 'node-c', 'Charlie');

  const projectId = await createProject(app, alice.token, 'demo');
  const inviteToken = await createInvite(app, alice.token, projectId);
  const joined = await requestJson(app, `/projects/${projectId}/join`, {
    method: 'POST',
    token: bob.token,
    body: { inviteToken },
  });
  assert.equal(joined.status, 200);

  const visible = await requestJson(app, '/nodes', { token: alice.token });
  assert.equal(visible.status, 200);
  const visibleNodeIds = new Set(
    (visible.json as Array<Record<string, unknown>>).map((node) => node.nodeId as string)
  );
  assert.equal(visibleNodeIds.has('node-a'), true);
  assert.equal(visibleNodeIds.has('node-b'), true);
  assert.equal(visibleNodeIds.has('node-c'), false);

  const hiddenNode = await requestJson(app, `/nodes/${charlie.nodeId}`, {
    token: alice.token,
  });
  assert.equal(hiddenNode.status, 404);

  const visibleNode = await requestJson(app, `/nodes/${bob.nodeId}`, {
    token: alice.token,
  });
  assert.equal(visibleNode.status, 200);
});

test('non-members cannot read project details', async () => {
  const { app } = createTestApp();
  const owner = await registerNode(app, 'node-a', 'Alice');
  const other = await registerNode(app, 'node-b', 'Bob');
  const projectId = await createProject(app, owner.token, 'demo');

  const forbidden = await requestJson(app, `/projects/${projectId}`, {
    token: other.token,
  });
  assert.equal(forbidden.status, 403);
  assert.equal((forbidden.json as Record<string, unknown>).error, 'Not a project member');
});

test('invite join binds membership to the authenticated caller and enforces invite usage', async () => {
  const { app } = createTestApp();
  const owner = await registerNode(app, 'node-a', 'Alice');
  const bob = await registerNode(app, 'node-b', 'Bob');
  const charlie = await registerNode(app, 'node-c', 'Charlie');
  const projectId = await createProject(app, owner.token, 'demo');
  const inviteToken = await createInvite(app, owner.token, projectId, { maxUses: 1 });

  const joined = await requestJson(app, `/projects/${projectId}/join`, {
    method: 'POST',
    token: bob.token,
    body: {
      inviteToken,
      nodeId: 'node-a',
    },
  });

  assert.equal(joined.status, 200);
  assert.equal((joined.json as Record<string, unknown>).nodeId, 'node-b');

  const exhausted = await requestJson(app, `/projects/${projectId}/join`, {
    method: 'POST',
    token: charlie.token,
    body: { inviteToken },
  });
  assert.equal(exhausted.status, 410);
});

test('only the project owner can revoke invites', async () => {
  const { app } = createTestApp();
  const owner = await registerNode(app, 'node-a', 'Alice');
  const member = await registerNode(app, 'node-b', 'Bob');
  const projectId = await createProject(app, owner.token, 'demo');
  const joinInviteToken = await createInvite(app, owner.token, projectId);

  const joined = await requestJson(app, `/projects/${projectId}/join`, {
    method: 'POST',
    token: member.token,
    body: { inviteToken: joinInviteToken },
  });
  assert.equal(joined.status, 200);

  const revokeInvite = await requestJson(app, `/projects/${projectId}/invites`, {
    method: 'POST',
    token: owner.token,
    body: {},
  });
  assert.equal(revokeInvite.status, 201);
  const inviteId = (revokeInvite.json as Record<string, unknown>).inviteId as string;

  const forbidden = await requestJson(app, `/projects/${projectId}/invites/${inviteId}`, {
    method: 'DELETE',
    token: member.token,
  });
  assert.equal(forbidden.status, 403);

  const deleted = await requestJson(app, `/projects/${projectId}/invites/${inviteId}`, {
    method: 'DELETE',
    token: owner.token,
  });
  assert.equal(deleted.status, 200);
});

test('skill registration binds to the caller and deletion is limited to skill owner or project owner', async () => {
  const { app } = createTestApp();
  const owner = await registerNode(app, 'node-a', 'Alice');
  const member = await registerNode(app, 'node-b', 'Bob');
  const projectId = await createProject(app, owner.token, 'demo');
  const inviteToken = await createInvite(app, owner.token, projectId);

  const joined = await requestJson(app, `/projects/${projectId}/join`, {
    method: 'POST',
    token: member.token,
    body: { inviteToken },
  });
  assert.equal(joined.status, 200);

  const skill = await requestJson(app, `/projects/${projectId}/skills`, {
    method: 'POST',
    token: member.token,
    body: {
      name: 'reviewer',
      description: 'reviews code',
      nodeId: 'node-a',
    },
  });
  assert.equal(skill.status, 201);
  const skillId = (skill.json as Record<string, unknown>).skillId as string;

  const skills = await requestJson(app, `/projects/${projectId}/skills`, {
    token: owner.token,
  });
  assert.equal(skills.status, 200);
  const rows = skills.json as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.nodeId, 'node-b');

  const outsider = await registerNode(app, 'node-c', 'Charlie');
  const outsiderDelete = await requestJson(app, `/projects/${projectId}/skills/${skillId}`, {
    method: 'DELETE',
    token: outsider.token,
  });
  assert.equal(outsiderDelete.status, 403);

  const ownerDelete = await requestJson(app, `/projects/${projectId}/skills/${skillId}`, {
    method: 'DELETE',
    token: owner.token,
  });
  assert.equal(ownerDelete.status, 200);
});
