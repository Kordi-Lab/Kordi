import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { insertNode, getNode, getNodeByTokenHash, updateNodeTokenHash } from './db/queries.js';
import {
  validateDisplayName,
  validateEndpoint,
  validateNodeId,
  validateOwnerName,
  validatePublicKey,
  validateRuntime,
} from './validation.js';

export type Env = { Variables: { nodeId: string; db: Database.Database } };

/** Hash a token with SHA-256 for storage. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Generate a cryptographically random bearer token. */
function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Auth routes: register and refresh. */
export function authRoutes(db: Database.Database): Hono<Env> {
  const app = new Hono<Env>();

  app.post('/auth/register', async (c) => {
    const body = await c.req.json<{
      nodeId: string;
      displayName: string;
      runtime: string;
      endpoint: string;
      publicKey?: string;
      ownerName: string;
    }>();

    const validationError =
      validateNodeId(body.nodeId) ??
      validateDisplayName(body.displayName) ??
      validateRuntime(body.runtime) ??
      validateEndpoint(body.endpoint) ??
      validateOwnerName(body.ownerName) ??
      validatePublicKey(body.publicKey);

    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const existing = getNode(db, body.nodeId);
    if (existing) {
      return c.json({ error: 'Node already registered' }, 409);
    }

    const token = generateToken();
    const tokenHash = hashToken(token);

    insertNode(db, {
      node_id: body.nodeId,
      display_name: body.displayName,
      runtime: body.runtime,
      endpoint: body.endpoint,
      public_key: body.publicKey ?? null,
      owner_name: body.ownerName,
      token_hash: tokenHash,
    });

    return c.json({ token, nodeId: body.nodeId }, 201);
  });

  app.post('/auth/refresh', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing bearer token' }, 401);
    }

    const oldToken = authHeader.slice(7);
    const oldHash = hashToken(oldToken);
    const node = getNodeByTokenHash(db, oldHash);

    if (!node) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    const newToken = generateToken();
    const newHash = hashToken(newToken);
    updateNodeTokenHash(db, node.node_id, newHash);

    return c.json({ token: newToken, nodeId: node.node_id });
  });

  return app;
}

/** Middleware: verify bearer token, set nodeId in context. */
export function requireAuth(db: Database.Database) {
  return createMiddleware<Env>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing bearer token' }, 401);
    }

    const token = authHeader.slice(7);
    const hash = hashToken(token);
    const node = getNodeByTokenHash(db, hash);

    if (!node) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    c.set('nodeId', node.node_id);
    c.set('db', db);
    await next();
  });
}
