import { Hono } from 'hono';
import type { Env } from '../auth.js';
import {
  getVisibleNodeForNode,
  listVisibleNodesForNode,
  updateNode,
} from '../db/queries.js';
import {
  validateDisplayName,
  validateEndpoint,
  validatePublicKey,
  validateRuntime,
} from '../validation.js';

export function nodeRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  /** Register or update node endpoint. */
  app.post('/', async (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const body = await c.req.json<{
      endpoint?: string;
      displayName?: string;
      runtime?: string;
      publicKey?: string;
    }>();

    const validationError =
      (body.endpoint !== undefined ? validateEndpoint(body.endpoint) : null) ??
      (body.displayName !== undefined ? validateDisplayName(body.displayName) : null) ??
      (body.runtime !== undefined ? validateRuntime(body.runtime) : null) ??
      (body.publicKey !== undefined ? validatePublicKey(body.publicKey) : null);

    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const updated = updateNode(db, nodeId, {
      endpoint: body.endpoint,
      display_name: body.displayName,
      runtime: body.runtime,
      public_key: body.publicKey,
    });

    if (!updated) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    return c.json({ ok: true, nodeId });
  });

  /** Lookup a visible node by ID. */
  app.get('/:id', (c) => {
    const db = c.get('db');
    const requesterNodeId = c.get('nodeId');
    const node = getVisibleNodeForNode(db, requesterNodeId, c.req.param('id'));

    if (!node) {
      return c.json({ error: 'Node not found or not visible' }, 404);
    }

    return c.json({
      nodeId: node.node_id,
      displayName: node.display_name,
      runtime: node.runtime,
      endpoint: node.endpoint,
      publicKey: node.public_key,
      ownerName: node.owner_name,
      createdAt: node.created_at,
    });
  });

  /** Update own node. */
  app.patch('/:id', async (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const targetId = c.req.param('id');

    if (nodeId !== targetId) {
      return c.json({ error: 'Can only update own node' }, 403);
    }

    const body = await c.req.json<{
      endpoint?: string;
      displayName?: string;
      runtime?: string;
      publicKey?: string;
    }>();

    const validationError =
      (body.endpoint !== undefined ? validateEndpoint(body.endpoint) : null) ??
      (body.displayName !== undefined ? validateDisplayName(body.displayName) : null) ??
      (body.runtime !== undefined ? validateRuntime(body.runtime) : null) ??
      (body.publicKey !== undefined ? validatePublicKey(body.publicKey) : null);

    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const updated = updateNode(db, nodeId, {
      endpoint: body.endpoint,
      display_name: body.displayName,
      runtime: body.runtime,
      public_key: body.publicKey,
    });

    if (!updated) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    return c.json({ ok: true, nodeId });
  });

  /** List nodes visible to the authenticated node. */
  app.get('/', (c) => {
    const db = c.get('db');
    const nodeId = c.get('nodeId');
    const nodes = listVisibleNodesForNode(db, nodeId);

    return c.json(nodes.map((n) => ({
      nodeId: n.node_id,
      displayName: n.display_name,
      runtime: n.runtime,
      endpoint: n.endpoint,
      ownerName: n.owner_name,
      createdAt: n.created_at,
    })));
  });

  return app;
}
