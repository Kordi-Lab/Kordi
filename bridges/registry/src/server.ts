import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type Database from 'better-sqlite3';
import { authRoutes, requireAuth, type Env } from './auth.js';
import { nodeRoutes } from './routes/nodes.js';
import { projectRoutes } from './routes/projects.js';
import { inviteRoutes } from './routes/invites.js';
import { skillRoutes } from './routes/skills.js';

/** Create the Hono application with all routes wired. */
export function createApp(db: Database.Database): Hono<Env> {
  const app = new Hono<Env>();

  // Request logging
  app.use('*', logger());

  // Health check (no auth)
  app.get('/health', (c) => c.json({ ok: true }));

  // Auth routes (no auth required)
  app.route('/', authRoutes(db));

  // Protected routes — require bearer token
  const auth = requireAuth(db);
  app.use('/nodes/*', auth);
  app.use('/nodes', auth);
  app.use('/projects/*', auth);
  app.use('/projects', auth);

  // Route groups
  app.route('/nodes', nodeRoutes());
  app.route('/projects', projectRoutes());
  app.route('/projects', inviteRoutes());
  app.route('/projects', skillRoutes());

  return app;
}
