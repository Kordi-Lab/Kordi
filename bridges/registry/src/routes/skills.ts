import { Hono } from 'hono';
import crypto from 'node:crypto';
import type { Env } from '../auth.js';
import {
  deleteSkill,
  getProject,
  getSkill,
  insertSkill,
  isProjectMember,
  listSkills,
} from '../db/queries.js';
import {
  validateDescription,
  validateSkillName,
} from '../validation.js';

export function skillRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  /** Register an agent skill in a project. */
  app.post('/:id/skills', async (c) => {
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
      name: string;
      description?: string;
    }>();

    const validationError =
      validateSkillName(body.name) ??
      validateDescription(body.description);

    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const skillNodeId = nodeId;
    const skillId = crypto.randomUUID();

    insertSkill(db, {
      skill_id: skillId,
      node_id: skillNodeId,
      project_id: projectId,
      name: body.name,
      description: body.description ?? null,
    });

    return c.json({ skillId }, 201);
  });

  /** List all skills across project agents. */
  app.get('/:id/skills', (c) => {
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

    const skills = listSkills(db, projectId);
    return c.json(skills.map((s) => ({
      skillId: s.skill_id,
      nodeId: s.node_id,
      name: s.name,
      description: s.description,
      createdAt: s.created_at,
    })));
  });

  /** Unregister a skill. Skill owner or project owner only. */
  app.delete('/:id/skills/:sid', (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const projectId = c.req.param('id');
    const skillId = c.req.param('sid');

    const project = getProject(db, projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    if (!isProjectMember(db, projectId, nodeId) && project.owner_node_id !== nodeId) {
      return c.json({ error: 'Not a project member' }, 403);
    }

    const skill = getSkill(db, skillId);
    if (!skill || skill.project_id !== projectId) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    if (skill.node_id !== nodeId && project.owner_node_id !== nodeId) {
      return c.json({ error: 'Only the skill owner or project owner can delete a skill' }, 403);
    }

    deleteSkill(db, skillId);
    return c.json({ ok: true });
  });

  return app;
}
