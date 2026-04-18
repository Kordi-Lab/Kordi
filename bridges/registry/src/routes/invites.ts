import { Hono } from 'hono';
import crypto from 'node:crypto';
import type { Env } from '../auth.js';
import {
  getInviteByIdAndProject,
  getProject,
  insertInvite,
  joinProjectWithInvite,
  listInvites,
  deleteInvite,
  isProjectMember,
} from '../db/queries.js';
import {
  validateAgentRole,
  validatePositiveInteger,
} from '../validation.js';

/** Hash invite token for storage. */
function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function inviteRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  /** Generate an invite token for a project. Members only. */
  app.post('/:id/invites', async (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const projectId = c.req.param('id');

    const project = getProject(db, projectId);
    if (!project || project.status !== 'active') {
      return c.json({ error: 'Project not found' }, 404);
    }

    if (!isProjectMember(db, projectId, nodeId) && project.owner_node_id !== nodeId) {
      return c.json({ error: 'Not a project member' }, 403);
    }

    const body = await c.req.json<{
      maxUses?: number;
      expiresIn?: number; // seconds from now
    }>().catch(() => ({} as { maxUses?: number; expiresIn?: number }));

    const validationError =
      validatePositiveInteger(body.maxUses, 'maxUses') ??
      validatePositiveInteger(body.expiresIn, 'expiresIn');

    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const inviteToken = crypto.randomBytes(24).toString('base64url');
    const inviteId = crypto.randomUUID();
    const tokenHash = hashInviteToken(inviteToken);

    let expiresAt: string | null = null;
    if (body.expiresIn && body.expiresIn > 0) {
      expiresAt = new Date(Date.now() + body.expiresIn * 1000).toISOString();
    }

    insertInvite(db, {
      invite_id: inviteId,
      project_id: projectId,
      token_hash: tokenHash,
      created_by: nodeId,
      max_uses: body.maxUses ?? null,
      expires_at: expiresAt,
    });

    return c.json({
      inviteToken,
      inviteUrl: `/projects/${projectId}/join?token=${inviteToken}`,
      inviteId,
    }, 201);
  });

  /** Join a project via invite token. */
  app.post('/:id/join', async (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const projectId = c.req.param('id');

    const body = await c.req.json<{
      inviteToken: string;
      agentRole?: string;
    }>();

    if (!body.inviteToken) {
      return c.json({ error: 'inviteToken is required' }, 400);
    }

    const validationError = validateAgentRole(body.agentRole);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const tokenHash = hashInviteToken(body.inviteToken);
    const result = joinProjectWithInvite(
      db,
      projectId,
      tokenHash,
      nodeId,
      body.agentRole ?? 'member'
    );

    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 410);
    }

    return c.json({ ok: true, projectId: result.projectId, nodeId: result.nodeId });
  });

  /** List active invites for a project. Members only. */
  app.get('/:id/invites', (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const projectId = c.req.param('id');

    const project = getProject(db, projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    if (!isProjectMember(db, projectId, nodeId) && project.owner_node_id !== nodeId) {
      return c.json({ error: 'Not a project member' }, 403);
    }

    const invites = listInvites(db, projectId);
    return c.json(invites.map((inv) => ({
      inviteId: inv.invite_id,
      createdBy: inv.created_by,
      maxUses: inv.max_uses,
      useCount: inv.use_count,
      expiresAt: inv.expires_at,
      createdAt: inv.created_at,
    })));
  });

  /** Revoke an invite. Owner only. */
  app.delete('/:id/invites/:iid', (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const projectId = c.req.param('id');
    const inviteId = c.req.param('iid');

    const project = getProject(db, projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    if (project.owner_node_id !== nodeId) {
      return c.json({ error: 'Only owner can revoke invites' }, 403);
    }

    const invite = getInviteByIdAndProject(db, inviteId, projectId);
    if (!invite) {
      return c.json({ error: 'Invite not found' }, 404);
    }

    deleteInvite(db, inviteId);
    return c.json({ ok: true });
  });

  return app;
}
