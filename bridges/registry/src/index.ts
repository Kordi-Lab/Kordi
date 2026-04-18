import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { initSchema } from './db/schema.js';
import { createApp } from './server.js';

/** Parse CLI args into a simple key-value map. */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      const key = arg.slice(2);
      args[key] = argv[++i];
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const port = parseInt(args['port'] ?? '7070', 10);
const dbPath = args['db'] ?? './bridges-registry.db';

// Initialize database
const db = new Database(dbPath);
initSchema(db);

// Create and start server
const app = createApp(db);

console.log(`Bridges Registry starting on port ${port} (db: ${dbPath})`);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Bridges Registry listening on http://localhost:${info.port}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
