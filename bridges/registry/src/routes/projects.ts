import { Hono } from 'hono';
import crypto from 'node:crypto';
import type { Env } from '../auth.js';
import {
  insertProject,
  getProject,
  listProjectsForNode,
  updateProject,
  insertProjectAgent,
  getProjectAgents,
  isProjectMember,
} from '../db/queries.js';
import {
  validateDescription,
  validateDisplayName,
  validateSlug,
} from '../validation.js';

export function projectRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  /** Create a new project. Owner is auto-added as a member. */
  app.post('/', async (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const body = await c.req.json<{
      slug: string;
      displayName: string;
      description?: string;
    }>();

    const validationError =
      validateSlug(body.slug) ??
      validateDisplayName(body.displayName) ??
      validateDescription(body.description);

    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const projectId = crypto.randomUUID();
    const ownerNodeId = nodeId;

    try {
      insertProject(db, {
        project_id: projectId,
        slug: body.slug,
        display_name: body.displayName,
        description: body.description ?? null,
        owner_node_id: ownerNodeId,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
        return c.json({ error: 'Slug already taken' }, 409);
      }
      throw err;
    }

    // Auto-add owner as member
    insertProjectAgent(db, {
      project_id: projectId,
      node_id: ownerNodeId,
      owner_name: null,
      agent_role: 'owner',
      permissions_json: null,
    });

    return c.json({ projectId }, 201);
  });

  /** List projects the authenticated node belongs to. */
  app.get('/', (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const projects = listProjectsForNode(db, nodeId);

    return c.json(projects.map((p) => ({
      projectId: p.project_id,
      slug: p.slug,
      displayName: p.display_name,
      description: p.description,
      ownerNodeId: p.owner_node_id,
      status: p.status,
      createdAt: p.created_at,
    })));
  });

  /** Get project details including member endpoints. */
  app.get('/:id', (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const project = getProject(db, c.req.param('id'));

    if (!project || project.status !== 'active') {
      return c.json({ error: 'Project not found' }, 404);
    }

    if (!isProjectMember(db, project.project_id, nodeId) && project.owner_node_id !== nodeId) {
      return c.json({ error: 'Not a project member' }, 403);
    }

    const agents = getProjectAgents(db, project.project_id);

    return c.json({
      projectId: project.project_id,
      slug: project.slug,
      displayName: project.display_name,
      description: project.description,
      ownerNodeId: project.owner_node_id,
      status: project.status,
      createdAt: project.created_at,
      agents: agents.map((a) => ({
        nodeId: a.node_id,
        agentRole: a.agent_role,
        status: a.status,
        joinedAt: a.joined_at,
      })),
    });
  });

  /** Update project metadata. Owner only. */
  app.patch('/:id', async (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const project = getProject(db, c.req.param('id'));

    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }
    if (project.owner_node_id !== nodeId) {
      return c.json({ error: 'Only owner can update project' }, 403);
    }

    const body = await c.req.json<{
      displayName?: string;
      description?: string;
      slug?: string;
    }>();

    const validationError =
      (body.displayName !== undefined ? validateDisplayName(body.displayName) : null) ??
      (body.description !== undefined ? validateDescription(body.description) : null) ??
      (body.slug !== undefined ? validateSlug(body.slug) : null);

    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const updated = updateProject(db, project.project_id, {
      display_name: body.displayName,
      description: body.description,
      slug: body.slug,
    });

    if (!updated) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    return c.json({ ok: true });
  });

  /** Archive project. Owner only. */
  app.delete('/:id', (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const project = getProject(db, c.req.param('id'));

    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }
    if (project.owner_node_id !== nodeId) {
      return c.json({ error: 'Only owner can archive project' }, 403);
    }

    updateProject(db, project.project_id, { status: 'archived' });
    return c.json({ ok: true });
  });

  return app;
}
